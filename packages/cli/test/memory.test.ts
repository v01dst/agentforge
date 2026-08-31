import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEMORY_CHAR_LIMIT,
  USER_CHAR_LIMIT,
  addMemoryEntry,
  loadMemory,
  loadMemorySync,
  loadPersonaSources,
  loadPersonaSourcesSync,
  parseMemoryDocument,
  removeMemoryEntry,
  renderPersonaBlock,
  renderSnapshot,
  replaceMemoryEntry,
} from '../src/memory/store.js';
import { createMemoryTool } from '../src/memory/tool.js';

const context = { runId: 'test', signal: new AbortController().signal } as never;

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'af-mem-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('memory documents round-trip through § serialization', async () => {
  await withTemp(async (root) => {
    await addMemoryEntry('memory', 'Project uses pnpm and turbo', { cwd: root });
    await addMemoryEntry('memory', 'Node >= 20.11 required', { cwd: root });
    const raw = await readFile(join(root, '.agentforge', 'memories', 'MEMORY.md'), 'utf8');
    assert.ok(raw.includes('§'), 'separator marker present');
    assert.deepEqual(parseMemoryDocument(raw), ['Project uses pnpm and turbo', 'Node >= 20.11 required']);
    const snapshot = await loadMemory('memory', root);
    assert.equal(snapshot.entries.length, 2);
    assert.ok(snapshot.used > 0 && snapshot.ratio > 0);
  });
});

test('exact duplicates are rejected without consuming capacity', async () => {
  await withTemp(async (root) => {
    const first = await addMemoryEntry('memory', 'Prefers concise answers', { cwd: root });
    assert.equal(first.ok, true);
    const duplicate = await addMemoryEntry('memory', '  prefers concise   answers ', { cwd: root });
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.message, /duplicate/i);
    const snapshot = await loadMemory('memory', root);
    assert.equal(snapshot.entries.length, 1);
  });
});

test('capacity limits are enforced with a consolidation hint', async () => {
  await withTemp(async (root) => {
    await addMemoryEntry('memory', 'x'.repeat(100), { cwd: root, limits: { memory: 120 } });
    const overflow = await addMemoryEntry('memory', 'y'.repeat(30), { cwd: root, limits: { memory: 120 } });
    assert.equal(overflow.ok, false);
    assert.match(overflow.message, /exceed the limit/);
    assert.match(overflow.message, /Consolidate/);
    const snapshot = await loadMemory('memory', root);
    assert.equal(snapshot.entries.length, 1);
  });
});

test('replace and remove match by unique substring and reject ambiguity', async () => {
  await withTemp(async (root) => {
    await addMemoryEntry('memory', 'Staging server uses SSH port 2222', { cwd: root });
    await addMemoryEntry('memory', 'CI runs on GitHub Actions', { cwd: root });
    const replaced = await replaceMemoryEntry('memory', 'port 2222', 'Staging server moved to port 2223', { cwd: root });
    assert.equal(replaced.ok, true);
    let snapshot = await loadMemory('memory', root);
    assert.ok(snapshot.entries.some((entry) => entry.includes('port 2223')));

    // Create genuine ambiguity: two entries now mention 'port 22'.
    await addMemoryEntry('memory', 'Backup host also uses port 2222', { cwd: root });
    const ambiguous = await replaceMemoryEntry('memory', 'port 22', 'x', { cwd: root });
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.message, /more unique/);

    const removed = await removeMemoryEntry('memory', 'GitHub Actions', { cwd: root });
    assert.equal(removed.ok, true);
    snapshot = await loadMemory('memory', root);
    assert.equal(snapshot.entries.length, 2);

    const missing = await removeMemoryEntry('memory', 'does-not-exist', { cwd: root });
    assert.equal(missing.ok, false);
  });
});

test('replace is bound by the limit too', async () => {
  await withTemp(async (root) => {
    await addMemoryEntry('memory', 'short entry', { cwd: root, limits: { memory: 30 } });
    const grown = await replaceMemoryEntry('memory', 'short', 'z'.repeat(40), { cwd: root, limits: { memory: 30 } });
    assert.equal(grown.ok, false);
    assert.match(grown.message, /Shorten|limit/);
  });
});

test('user profile has its own file and tighter default limit', async () => {
  await withTemp(async (root) => {
    await addMemoryEntry('user', 'User prefers terse replies', { cwd: root });
    const snapshot = await loadMemory('user', root);
    assert.equal(snapshot.limit, USER_CHAR_LIMIT);
    assert.equal(snapshot.entries[0], 'User prefers terse replies');
    const raw = await readFile(join(root, '.agentforge', 'memories', 'USER.md'), 'utf8');
    assert.match(raw, /terse replies/);
    assert.equal(MEMORY_CHAR_LIMIT, 2200);
  });
});

test('global fallback: project file wins when both scopes have content', async () => {
  const project = await mkdtemp(join(tmpdir(), 'af-mem-proj-'));
  const fakeHome = await mkdtemp(join(tmpdir(), 'af-mem-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    // Write only to the global scope by pointing HOME at fakeHome.
    await addMemoryEntry('memory', 'global note', { cwd: project, global: true });
    await addMemoryEntry('memory', 'project note', { cwd: project, global: false });
    // Reads fall back across scopes only when the preferred scope is EMPTY —
    // the project file exists with content, so project entries win alone.
    const snapshot = await loadMemory('memory', project);
    assert.deepEqual(snapshot.entries, ['project note']);
    // The global file was never merged into the project file by writes.
    const rawProject = await readFile(join(project, '.agentforge', 'memories', 'MEMORY.md'), 'utf8');
    assert.ok(!rawProject.includes('global note'));
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(fakeHome, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test('snapshot renderer shows label, usage, and entries', () => {
  const rendered = renderSnapshot('memory', ['alpha', 'beta']);
  assert.match(rendered, /MEMORY \(your personal notes\)/);
  assert.match(rendered, /chars\]/);
  assert.match(rendered, /alpha§beta/);
  const empty = renderSnapshot('user', []);
  assert.match(empty, /USER PROFILE/);
});

test('loadMemorySync mirrors loadMemory without awaiting', async () => {
  await withTemp(async (root) => {
    await addMemoryEntry('memory', 'sync me', { cwd: root });
    const sync = loadMemorySync('memory', root);
    const asyncSnapshot = await loadMemory('memory', root);
    assert.deepEqual(sync.entries, asyncSnapshot.entries);
    assert.equal(sync.used, asyncSnapshot.used);
    const missing = loadMemorySync('user', root);
    assert.deepEqual(missing.entries, []);
  });
});

test('persona sources read SOUL.md and AGENTS.md and compose in order', async () => {
  await withTemp(async (root) => {
    await mkdir(join(root, '.agentforge'), { recursive: true });
    await writeFile(join(root, '.agentforge', 'SOUL.md'), 'Be direct. Prefer examples.', 'utf8');
    await writeFile(join(root, 'AGENTS.md'), 'Use pnpm. Never commit secrets.', 'utf8');
    const sources = await loadPersonaSources(root);
    const block = renderPersonaBlock(sources);
    assert.ok(block);
    assert.match(block, /\[persona\]/);
    assert.match(block, /Be direct/);
    assert.match(block, /\[project conventions — AGENTS\.md\]/);
    assert.match(block, /Use pnpm/);
    // Persona precedes conventions.
    assert.ok(block.indexOf('[persona]') < block.indexOf('[project conventions'));
  });
});

test('persona tolerates absence and empty files', async () => {
  await withTemp(async (root) => {
    await mkdir(join(root, '.agentforge'), { recursive: true });
    await writeFile(join(root, '.agentforge', 'SOUL.md'), '   \n', 'utf8');
    const sources = await loadPersonaSources(root);
    assert.equal(sources.soul, undefined);
    assert.equal(sources.agents, undefined);
    assert.equal(renderPersonaBlock({}), undefined);
    const syncSources = loadPersonaSourcesSync(root);
    assert.equal(syncSources.agents, undefined);
  });
});

test('memory tool performs add/replace/remove and reports live state', async () => {
  await withTemp(async (root) => {
    const tool = createMemoryTool({ root });
    const added = (await tool.execute({ action: 'add', target: 'memory', content: 'Tool-driven entry' }, context)) as { ok: boolean; entries: string[]; limit: number };
    assert.equal(added.ok, true);
    assert.equal(added.limit, MEMORY_CHAR_LIMIT);
    const replaced = (await tool.execute({ action: 'replace', target: 'memory', old_text: 'Tool-driven', content: 'Renamed entry' }, context)) as { ok: boolean };
    assert.equal(replaced.ok, true);
    const removed = (await tool.execute({ action: 'remove', target: 'memory', old_text: 'Renamed' }, context)) as { ok: boolean; entries: string[] };
    assert.equal(removed.ok, true);
    assert.deepEqual(removed.entries, []);
    const badAction = (await tool.execute({ action: 'add', target: 'memory' }, context)) as { ok: boolean; message: string };
    assert.equal(badAction.ok, false);
  });
});

test('memory tool refuses writes in read-only contexts', async () => {
  await withTemp(async (root) => {
    const tool = createMemoryTool({ root, readOnly: true });
    const result = (await tool.execute({ action: 'add', target: 'memory', content: 'nope' }, context)) as { ok: boolean; message: string };
    assert.equal(result.ok, false);
    assert.match(result.message, /disabled/);
  });
});
