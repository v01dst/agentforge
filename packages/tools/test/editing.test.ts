import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import type { ToolContext } from '@agentforge-oss/core';
import { createApplyPatchTool, createGitDiffTool } from '../src/editing.js';

const runFile = promisify(execFile);
const context = {} as ToolContext;

async function makeTmp(prefix = 'editing-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

const BASE_FILE = 'alpha\nbeta\ngamma\n';
const PATCH_SIMPLE = `--- a/hello.txt
+++ b/hello.txt
@@ -1,3 +1,3 @@
 alpha
-beta
+BETA
 gamma
`;

test('apply_patch applies a clean patch and reports counts', async () => {
  const root = await makeTmp();
  try {
    await writeFile(join(root, 'hello.txt'), BASE_FILE);
    const tool = createApplyPatchTool({ root, allowWrite: true });
    const result = await tool.execute({ patch: PATCH_SIMPLE, dryRun: false }, context);
    assert.equal(result.applied, true);
    assert.equal(result.dryRun, false);
    assert.deepEqual(result.files, [{ path: 'hello.txt', added: 1, removed: 1 }]);
    assert.equal(await readFile(join(root, 'hello.txt'), 'utf8'), 'alpha\nBETA\ngamma\n');
    assert.match(result.diff, /^--- a\/hello\.txt\n/);
    assert.match(result.diff, /\+BETA\n/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('apply_patch dry run validates and returns diff without writing', async () => {
  const root = await makeTmp();
  try {
    await writeFile(join(root, 'hello.txt'), BASE_FILE);
    const tool = createApplyPatchTool({ root, allowWrite: true });
    const result = await tool.execute({ patch: PATCH_SIMPLE }, context);
    assert.equal(result.applied, false);
    assert.equal(result.dryRun, true);
    assert.match(result.diff, /-beta\n\+BETA\n/);
    assert.equal(await readFile(join(root, 'hello.txt'), 'utf8'), BASE_FILE);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('apply_patch rejects hunks that do not apply', async () => {
  const root = await makeTmp();
  try {
    await writeFile(join(root, 'hello.txt'), 'totally different content\n');
    const tool = createApplyPatchTool({ root, allowWrite: true });
    await assert.rejects(
      () => tool.execute({ patch: PATCH_SIMPLE, dryRun: true }, context),
      /does not apply cleanly/,
    );
    // File untouched even with dryRun=false (validate-all-then-write).
    await assert.rejects(() => tool.execute({ patch: PATCH_SIMPLE, dryRun: false }, context));
    assert.equal(await readFile(join(root, 'hello.txt'), 'utf8'), 'totally different content\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('apply_patch refuses writes when allowWrite is false', async () => {
  const root = await makeTmp();
  try {
    await writeFile(join(root, 'hello.txt'), BASE_FILE);
    const tool = createApplyPatchTool({ root, allowWrite: false });
    await assert.rejects(
      () => tool.execute({ patch: PATCH_SIMPLE, dryRun: false }, context),
      /writes are disabled/i,
    );
    // Dry-run still allowed read-only.
    const result = await tool.execute({ patch: PATCH_SIMPLE, dryRun: true }, context);
    assert.equal(result.dryRun, true);
    assert.equal(await readFile(join(root, 'hello.txt'), 'utf8'), BASE_FILE);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('apply_patch rejects paths escaping the workspace root', async () => {
  const root = await makeTmp();
  try {
    const escapePatch = [
      '--- a/../outside.txt',
      '+++ b/../outside.txt',
      '@@ -1,1 +1,1 @@',
      '-one',
      '+two',
      '',
    ].join('\n');
    const tool = createApplyPatchTool({ root, allowWrite: true });
    await assert.rejects(
      () => tool.execute({ patch: escapePatch, dryRun: true }, context),
      /escapes the configured workspace root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await runFile('git', args, { cwd });
}

test('inspect_git_diff reports status and diff on a real temp repo', async () => {
  const root = await makeTmp('git-repo-');
  try {
    await git(root, 'init');
    await git(root, 'config', 'user.email', 'test@example.com');
    await git(root, 'config', 'user.name', 'Test');
    await writeFile(join(root, 'a.txt'), 'one\n');
    await git(root, 'add', 'a.txt');
    await git(root, 'commit', '-m', 'initial');
    await writeFile(join(root, 'a.txt'), 'one\ntwo\n');

    const tool = createGitDiffTool({ root });
    const result = await tool.execute({ staged: false }, context);
    assert.equal(result.isRepo, true);
    assert.match(result.status, /a\.txt/);
    assert.match(result.diff, /\+two\n/);

    await git(root, 'add', 'a.txt');
    const staged = await tool.execute({ staged: true }, context);
    assert.match(staged.diff, /\+two\n/);
    const unstaged = await tool.execute({ staged: false }, context);
    assert.equal(unstaged.diff.trim(), '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('inspect_git_diff gives a clean error outside a repository', async () => {
  const root = await makeTmp('not-repo-');
  try {
    const tool = createGitDiffTool({ root });
    await assert.rejects(
      () => tool.execute({ staged: false }, context),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^Not a git repository:/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
