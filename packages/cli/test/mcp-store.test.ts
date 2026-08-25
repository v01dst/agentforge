import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpCommand } from '../src/commands.js';
import { readExtensions, writeExtensions } from '../src/extensions/store.js';

const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

test('mcp add/list/remove manage .agentforge/extensions.json', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agentforge-mcp-'));
  const previousCwd = process.cwd();
  process.chdir(project);
  try {
    await writeExtensions({}, project);

    await mcpCommand(['add', 'files', '--', 'npx', '-y', '@modelcontextprotocol/server-filesystem', '.'], { cwd: project });
    let stored = await readExtensions(project);
    assert.equal(stored.mcp?.servers?.length, 1);
    assert.deepEqual(stored.mcp?.servers?.[0]?.command, ['npx', '-y', '@modelcontextprotocol/server-filesystem', '.']);
    assert.equal(stored.mcp?.servers?.[0]?.name, 'files');

    // Duplicate registration is rejected.
    await assert.rejects(() => mcpCommand(['add', 'files', '--', 'echo'], {}), /already configured/);

    // A lone separator or flag-only command is rejected.
    await assert.rejects(() => mcpCommand(['add', 'empty', '--', '--'], {}), /Missing command/);
    await assert.rejects(() => mcpCommand(['add', 'flaggy'], {}), /Missing command/);

    await delay(5);
    await mcpCommand(['remove', 'files'], {});
    stored = await readExtensions(project);
    assert.equal(stored.mcp?.servers?.length, 0);

    const code = await mcpCommand(['remove', 'ghost'], {});
    assert.equal(code, 1);
  } finally {
    process.chdir(previousCwd);
    await rm(project, { recursive: true, force: true });
  }
});
