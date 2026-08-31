import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workflowsValidateCommand } from '../src/commands.js';

const validDoc = {
  version: 1,
  name: 'cli-check',
  start: 'start',
  nodes: [
    { id: 'start', type: 'input' },
    { id: 'out', type: 'output' },
  ],
  edges: [{ from: 'start', to: 'out' }],
};

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'af-wfcli-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('workflows validate accepts a well-formed document and exits 0', async () => {
  await withTemp(async (root) => {
    const file = join(root, 'flow.json');
    await writeFile(file, JSON.stringify(validDoc), 'utf8');
    const exit = await workflowsValidateCommand(file, {});
    assert.equal(exit, 0);
  });
});

test('workflows validate reports precise errors and exits 1', async () => {
  await withTemp(async (root) => {
    const file = join(root, 'broken.json');
    await writeFile(file, JSON.stringify({
      version: 1,
      name: 'broken',
      nodes: [{ id: 'a', type: 'input' }],
      edges: [{ from: 'a', to: 'missing' }],
    }), 'utf8');
    let reported = '';
    const originalError = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
      reported += chunk;
      return true;
    };
    try {
      const exit = await workflowsValidateCommand(file, {});
      assert.equal(exit, 1);
      assert.match(reported, /unknown target node 'missing'/);
    } finally {
      (process.stderr as unknown as { write: (chunk: string) => boolean }).write = originalError;
    }
  });
});

test('workflows validate distinguishes bad JSON from bad documents', async () => {
  await withTemp(async (root) => {
    const file = join(root, 'bad.json');
    await writeFile(file, '{nope', 'utf8');
    await assert.rejects(() => workflowsValidateCommand(file, {}), /not valid JSON/);
    await assert.rejects(() => workflowsValidateCommand(join(root, 'ghost.json'), {}), /not found/);
  });
});
