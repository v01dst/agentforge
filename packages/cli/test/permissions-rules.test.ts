import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
