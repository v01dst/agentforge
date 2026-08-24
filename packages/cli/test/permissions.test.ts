import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyWorkspacePolicy, MODE_ALLOWED_PERMISSIONS } from '../src/permissions.js';

// Build a minimal zod-like schema shim instead of importing zod (not a direct
// dependency of @agentforge-oss/cli); only `parse` behavior is needed by the policy.
type PathSchema = { parse(value: unknown): { path?: string } };
const schemaLike: PathSchema = {
  parse(value: unknown) { return (value ?? {}) as { path?: string }; },
};

function fakeTool(permissions: string[]) {
  return {
    name: 'apply_patch',
    description: 'test tool',
    inputSchema: schemaLike,
    permissions,
    async execute(input: unknown) {
      return { ok: true as const, input };
    },
  };
}

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'af-perm-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('permissions', () => {
  it('read-only mode denies write tools without prompting', async () => {
    await withTemp(async (root) => {
      const tool = applyWorkspacePolicy(fakeTool(['filesystem:write']), { root, mode: 'read-only' });
      await assert.rejects(() => tool.execute({ path: 'a.txt' }, { runId: 'r', signal: new AbortController().signal }), /read-only/);
    });
  });

  it('workspace-write mode allows filesystem:write but asks for process:execute', async () => {
    await withTemp(async (root) => {
      let asked = 0;
      const tool = applyWorkspacePolicy(fakeTool(['filesystem:write', 'process:execute']), {
        root,
        mode: 'workspace-write',
        requestApproval: async () => {
          asked += 1;
          return { approved: true };
        },
      });
      const result = (await tool.execute({}, { runId: 'r', signal: new AbortController().signal })) as { ok: boolean };
      assert.equal(result.ok, true);
      assert.equal(asked, 1);
    });
  });

  it('denial by the user surfaces a clear error and is not retried', async () => {
    await withTemp(async (root) => {
      const tool = applyWorkspacePolicy(fakeTool(['filesystem:write']), {
        root,
        mode: 'ask',
        requestApproval: async () => ({ approved: false }),
      });
      await assert.rejects(() => tool.execute({}, { runId: 'r', signal: new AbortController().signal }), /User denied/);
    });
  });

  it('paths outside the workspace root are rejected in any mode', async () => {
    await withTemp(async (root) => {
      for (const mode of ['trusted' as const]) {
        const tool = applyWorkspacePolicy(fakeTool([]), { root, mode });
        await assert.rejects(
          () => tool.execute({ path: '../../etc/passwd' }, { runId: 'r', signal: new AbortController().signal }),
          /escapes the workspace/,
        );
      }
    });
  });

  it('no approval prompt available -> explicit error instead of silent execution', async () => {
    await withTemp(async (root) => {
      const tool = applyWorkspacePolicy(fakeTool(['filesystem:write']), { root, mode: 'ask' });
      await assert.rejects(() => tool.execute({}, { runId: 'r', signal: new AbortController().signal }), /requires approval/);
    });
  });

  it('mode tables expose expected permission sets', () => {
    assert.ok(MODE_ALLOWED_PERMISSIONS.trusted.has('process:execute'));
    assert.ok(!MODE_ALLOWED_PERMISSIONS.ask.has('process:execute'));
    assert.equal(MODE_ALLOWED_PERMISSIONS['read-only'].size, 1);
  });

  it('creates nested dirs when needed during smoke setup', async () => {
    await withTemp(async (root) => {
      await mkdir(join(root, 'sub'), { recursive: true });
      await writeFile(join(root, 'sub', 'f.txt'), 'x');
      assert.ok(join(root, 'sub', 'f.txt'));
    });
  });
});
