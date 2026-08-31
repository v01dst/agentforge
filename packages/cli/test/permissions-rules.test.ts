import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  addPermissionRule,
  evaluateRules,
  permissionsFilePath,
  readPermissionRules,
  removePermissionRule,
  validatePermissionRule,
  writePermissionRules,
} from '../src/permissions-store.js';
import { applyWorkspacePolicy } from '../src/permissions.js';
import { createDoomLoopGuard } from '../src/guards/doom-loop.js';
import { evaluateInvocationRules, externalDirectories } from '../src/permissions-rules.js';

type PathSchema = { parse(value: unknown): { path?: string } };
const schemaLike: PathSchema = {
  parse(value: unknown) { return (value ?? {}) as { path?: string }; },
};

function fakeTool(name: string, permissions: string[]) {
  return {
    name,
    description: 'test tool',
    inputSchema: schemaLike,
    permissions,
    async execute(input: unknown) {
      return { ok: true as const, input };
    },
  };
}

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'af-rules-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('permissions store', () => {
  it('returns an empty rule set when no file exists', async () => {
    await withTemp(async (root) => {
      assert.deepEqual(await readPermissionRules(root), []);
    });
  });

  it('round-trips rules through .agentforge/permissions.json', async () => {
    await withTemp(async (root) => {
      await addPermissionRule('run_command', 'deny', {}, root);
      await addPermissionRule('mcp.files.read', 'allow', {}, root);
      const rules = await readPermissionRules(root);
      assert.equal(rules.length, 2);
      assert.deepEqual(rules.find((rule) => rule.tool === 'run_command'), { tool: 'run_command', action: 'deny' });
      const onDisk = JSON.parse(await readFile(permissionsFilePath(root), 'utf8')) as { rules: unknown[] };
      assert.equal(Array.isArray(onDisk.rules), true);
    });
  });

  it('refuses to silently replace an existing rule without --force', async () => {
    await withTemp(async (root) => {
      await addPermissionRule('apply_patch', 'allow', {}, root);
      await assert.rejects(() => addPermissionRule('apply_patch', 'deny', {}, root), /--force/);
      const replaced = await addPermissionRule('apply_patch', 'deny', { force: true }, root);
      assert.equal(replaced.replaced, true);
      assert.deepEqual(await readPermissionRules(root), [{ tool: 'apply_patch', action: 'deny' }]);
    });
  });

  it('removes rules and reports misses', async () => {
    await withTemp(async (root) => {
      await addPermissionRule('run_tests', 'allow', {}, root);
      assert.equal(await removePermissionRule('run_tests', root), true);
      assert.equal(await removePermissionRule('run_tests', root), false);
    });
  });

  it('validates tool names and actions', () => {
    assert.throws(() => validatePermissionRule({ tool: 'has space', action: 'allow' }), /tool name/);
    assert.throws(() => validatePermissionRule({ tool: 'x', action: 'maybe' }), /action must be/);
    assert.deepEqual(validatePermissionRule({ tool: '*', action: 'deny' }), { tool: '*', action: 'deny' });
  });

  it('corrupts loudly instead of failing open on malformed files', async () => {
    await withTemp(async (root) => {
      await writePermissionRules([], root);
      await writeFile(permissionsFilePath(root), '{"rules":"nope"}', 'utf8');
      await assert.rejects(() => readPermissionRules(root), /"rules" array/);
    });
  });
});

describe('evaluateRules', () => {
  it('specific rules beat the wildcard', () => {
    const rules = [
      { tool: '*', action: 'deny' as const },
      { tool: 'read_file', action: 'allow' as const },
    ];
    assert.equal(evaluateRules(rules, 'read_file'), 'allow');
    assert.equal(evaluateRules(rules, 'apply_patch'), 'deny');
  });

  it('deny beats allow at equal specificity', () => {
    const rules = [
      { tool: 'run_command', action: 'allow' as const },
      { tool: 'run_command', action: 'deny' as const },
    ];
    assert.equal(evaluateRules(rules, 'run_command'), 'deny');
  });

  it('returns undefined when nothing matches', () => {
    assert.equal(evaluateRules([], 'x'), undefined);
    assert.equal(evaluateRules([{ tool: 'y', action: 'deny' }], 'x'), undefined);
  });
});

describe('policy wiring for permission rules', () => {
  it('deny blocks the tool even in trusted mode', async () => {
    await withTemp(async (root) => {
      const tool = applyWorkspacePolicy(fakeTool('apply_patch', ['filesystem:write']), {
        root,
        mode: 'trusted',
        rules: [{ tool: 'apply_patch', action: 'deny' }],
      });
      await assert.rejects(
        () => tool.execute({ path: 'a.txt' }, { runId: 'r', signal: new AbortController().signal }),
        /blocked by a project permission rule/,
      );
    });
  });

  it('allow skips the approval prompt in ask mode', async () => {
    await withTemp(async (root) => {
      let asked = 0;
      const tool = applyWorkspacePolicy(fakeTool('apply_patch', ['filesystem:write']), {
        root,
        mode: 'ask',
        rules: [{ tool: 'apply_patch', action: 'allow' }],
        requestApproval: async () => {
          asked += 1;
          return { approved: false };
        },
      });
      const result = (await tool.execute({ path: 'a.txt' }, { runId: 'r', signal: new AbortController().signal })) as { ok: boolean };
      assert.equal(result.ok, true);
      assert.equal(asked, 0);
    });
  });

  it('allow never bypasses workspace path checks', async () => {
    await withTemp(async (root) => {
      const tool = applyWorkspacePolicy(fakeTool('apply_patch', ['filesystem:write']), {
        root,
        mode: 'ask',
        rules: [{ tool: 'apply_patch', action: 'allow' }],
      });
      await assert.rejects(
        () => tool.execute({ path: '../../etc/passwd' }, { runId: 'r', signal: new AbortController().signal }),
        /escapes the workspace/,
      );
    });
  });

  it('unrelated rules leave the normal mode flow untouched', async () => {
    await withTemp(async (root) => {
      const tool = applyWorkspacePolicy(fakeTool('apply_patch', ['filesystem:write']), {
        root,
        mode: 'ask',
        rules: [{ tool: 'run_command', action: 'deny' }],
        requestApproval: async () => ({ approved: true }),
      });
      const result = (await tool.execute({ path: 'a.txt' }, { runId: 'r', signal: new AbortController().signal })) as { ok: boolean };
      assert.equal(result.ok, true);
    });
  });
});

describe('Phase G: glob and hierarchy rules', () => {
  it('globs match tool names and beat the bare wildcard', () => {
    const rules = [
      { tool: '*', action: 'deny' as const },
      { tool: 'mcp.*', action: 'allow' as const },
    ];
    assert.equal(evaluateRules(rules, 'mcp.files.read'), 'allow');
    assert.equal(evaluateRules(rules, 'read_file'), 'deny');
  });

  it('dotted hierarchy rules cover descendants', () => {
    const rules = [{ tool: 'mcp.server', action: 'deny' as const }];
    assert.equal(evaluateRules(rules, 'mcp.server.tool'), 'deny');
    assert.equal(evaluateRules(rules, 'mcp.other.tool'), undefined);
    assert.equal(evaluateRules(rules, 'mcpserver'), undefined);
  });

  it('exact rules beat hierarchy rules beat globs', () => {
    const rules = [
      { tool: 'mcp.*', action: 'deny' as const },
      { tool: 'mcp.server', action: 'allow' as const },
      { tool: 'mcp.server.exact', action: 'deny' as const },
    ];
    assert.equal(evaluateRules(rules, 'mcp.server.other'), 'allow');
    assert.equal(evaluateRules(rules, 'mcp.server.exact'), 'deny');
    assert.equal(evaluateRules(rules, 'mcp.unlisted'), 'deny');
  });

  it('validators accept globs, hierarchy prefixes, and qualified rules', () => {
    assert.deepEqual(validatePermissionRule({ tool: 'mcp.*', action: 'allow' }), { tool: 'mcp.*', action: 'allow' });
    assert.deepEqual(validatePermissionRule({ tool: 'mcp.server', action: 'deny' }), { tool: 'mcp.server', action: 'deny' });
    assert.deepEqual(validatePermissionRule({ tool: 'run_command:prefix=git status', action: 'allow' }), { tool: 'run_command:prefix=git status', action: 'allow' });
    assert.deepEqual(validatePermissionRule({ tool: 'external_directory:/tmp/data', action: 'allow' }), { tool: 'external_directory:/tmp/data', action: 'allow' });
    assert.throws(() => validatePermissionRule({ tool: 'has space', action: 'allow' }), /tool name/);
    assert.throws(() => validatePermissionRule({ tool: 'read_file:bogus', action: 'allow' }), /tool name/);
  });
});

describe('Phase G: run_command prefix rules', () => {
  it('a prefix allow overrides a general run_command deny for matching lines', () => {
    
    const rules = [
      { tool: 'run_command', action: 'deny' as const },
      { tool: 'run_command:prefix=git', action: 'allow' as const },
    ];
    assert.equal(evaluateInvocationRules(rules, { tool: 'run_command', command: { command: 'git', args: ['status'] } }), 'allow');
    assert.equal(evaluateInvocationRules(rules, { tool: 'run_command', command: { command: 'git', args: [] } }), 'allow');
    assert.equal(evaluateInvocationRules(rules, { tool: 'run_command', command: { command: 'rm', args: ['-rf', 'x'] } }), 'deny');
    assert.equal(evaluateInvocationRules(rules, { tool: 'run_command', command: { command: 'gitk' } }), 'deny', 'gitk is not the git prefix');
  });

  it('prefix deny wins over exact allow, and deny sticks at equal specificity', () => {
    
    const rules = [
      { tool: 'run_command', action: 'allow' as const },
      { tool: 'run_command:prefix=rm -rf', action: 'deny' as const },
    ];
    assert.equal(evaluateInvocationRules(rules, { tool: 'run_command', command: { command: 'rm', args: ['-rf', 'build'] } }), 'deny');
    assert.equal(evaluateInvocationRules(rules, { tool: 'run_command', command: { command: 'ls', args: ['-la'] } }), 'allow');
  });

  it('prefix-allowed commands skip the approval prompt in ask mode', async () => {
    await withTemp(async (root) => {
      let asked = 0;
      const commandTool = {
        name: 'run_command',
        description: 'test runner',
        inputSchema: { parse(value: unknown) { return (value ?? {}) as Record<string, unknown>; } },
        permissions: ['process:execute'],
        async execute(input: unknown) { return { ok: true as const, input }; },
      };
      const tool = applyWorkspacePolicy(commandTool, {
        root,
        mode: 'ask',
        rules: [
          { tool: 'run_command', action: 'deny' },
          { tool: 'run_command:prefix=npm test', action: 'allow' },
        ],
        requestApproval: async () => {
          asked += 1;
          return { approved: false };
        },
      });
      const result = (await tool.execute({ command: 'npm', args: ['test'] }, { runId: 'r', signal: new AbortController().signal })) as { ok: boolean };
      assert.equal(result.ok, true);
      assert.equal(asked, 0);
      await assert.rejects(
        () => tool.execute({ command: 'rm', args: ['-rf', 'x'] }, { runId: 'r', signal: new AbortController().signal }),
        /blocked by a project permission rule/,
      );
    });
  });
});

describe('Phase G: external_directory grants', () => {
  it('granted external paths pass the boundary check; others still refused', async () => {
    await withTemp(async (root) => {
      const external = await mkdtemp(join(tmpdir(), 'af-external-'));
      try {
        const tool = applyWorkspacePolicy(fakeTool('read_file', ['filesystem:read']), {
          root,
          mode: 'ask',
          rules: [{ tool: `external_directory:${external}`, action: 'allow' }],
        });
        const granted = (await tool.execute({ path: join(external, 'notes.txt') }, { runId: 'r', signal: new AbortController().signal })) as { ok: boolean };
        assert.equal(granted.ok, true);
        await assert.rejects(
          () => tool.execute({ path: tmpdir() }, { runId: 'r', signal: new AbortController().signal }),
          /escapes the workspace/,
        );
      } finally {
        await rm(external, { recursive: true, force: true });
      }
    });
  });

  it('relative external_directory rules resolve against the workspace root', async () => {
    await withTemp(async (root) => {
      
      const dirs = externalDirectories([{ tool: 'external_directory:../sibling', action: 'allow' }], root);
      assert.equal(dirs.length, 1);
      assert.equal(dirs[0], join(dirname(root), 'sibling'));
    });
  });
});

describe('Phase G: doom-loop guard', () => {
  it('denies the third identical consecutive call and resets on change', async () => {
    const { createDoomLoopGuard } = await import('../src/guards/doom-loop.js');
    const guard = createDoomLoopGuard();
    const call = { id: '1', name: 'search_text', arguments: { pattern: 'x' } };
    assert.equal(await guard(call), undefined, 'first call allowed');
    assert.equal(await guard(call), undefined, 'second call allowed');
    const denied = await guard(call);
    assert.match(denied as string, /identical arguments/);
    assert.equal(await guard({ id: '2', name: 'search_text', arguments: { pattern: 'y' } }), undefined, 'changed args reset the loop');
    assert.equal(await guard({ id: '3', name: 'search_text', arguments: { pattern: 'y' } }), undefined);
  });

  it('custom maxRepeats and argument sensitivity', async () => {
    const { createDoomLoopGuard } = await import('../src/guards/doom-loop.js');
    const guard = createDoomLoopGuard({ maxRepeats: 2 });
    const first = { id: '1', name: 'read_file', arguments: { path: 'a.ts' } };
    assert.equal(await guard(first), undefined);
    assert.match((await guard(first)) as string, /read_file/);
  });
});
