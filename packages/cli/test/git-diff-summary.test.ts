import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitDiffSummary } from '../src/git-diff-summary.js';

const run = promisify(execFile);

test('gitDiffSummary returns the stat tail inside a repo and undefined outside', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'agentforge-git-'));
  const plain = await mkdtemp(join(tmpdir(), 'agentforge-nogit-'));
  try {
    await run('git', ['init', '-q'], { cwd: repo });
    await run('git', ['config', 'user.email', 't@t'], { cwd: repo });
    await run('git', ['config', 'user.name', 't'], { cwd: repo });
    await writeFile(join(repo, 'a.txt'), 'one\n');
    await run('git', ['add', '.'], { cwd: repo });
    await run('git', ['commit', '-qm', 'init'], { cwd: repo });
    await writeFile(join(repo, 'a.txt'), 'one\ntwo\n');

    const summary = await gitDiffSummary(repo);
    assert.ok(summary, 'summary exists');
    assert.match(summary, /a\.txt/);

    assert.equal(await gitDiffSummary(plain), undefined);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(plain, { recursive: true, force: true });
  }
});
