import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendSessionLog,
  forkSession,
  foldLogToMessages,
  loadFullTranscript,
  parseSessionLog,
  readSessionLog,
  sessionLogPath,
} from '../src/sessions/log.js';
import { newSessionId, saveSession, loadSession, SESSION_SCHEMA_VERSION } from '../src/sessions/store.js';

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'af-slog-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function seedLogSession(root: string): Promise<string> {
  const id = newSessionId();
  await mkdir(join(root, '.agentforge', 'sessions'), { recursive: true });
  await saveSession({
    id,
    title: 'parent',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [{ role: 'user', text: 'compacted away' }, { role: 'assistant', text: 'me too' }, { role: 'user', text: 'kept 1' }],
    summary: '[earlier conversation]',
    version: SESSION_SCHEMA_VERSION,
  }, root);
  await appendSessionLog(id, { type: 'user', text: 'first question' }, root);
  await appendSessionLog(id, { type: 'assistant', text: 'first answer' }, root);
  await appendSessionLog(id, { type: 'tool', text: 'read_file src/a.ts', meta: { tool: 'read_file', ms: 12 } }, root);
  await appendSessionLog(id, { type: 'user', text: 'follow-up' }, root);
  return id;
}

test('append + read round-trips NDJSON entries with metadata', async () => {
  await withTemp(async (root) => {
    const id = newSessionId();
    await appendSessionLog(id, { type: 'user', text: 'hello' }, root);
    await appendSessionLog(id, { type: 'tool', text: 'ls', meta: { tool: 'run_command', ms: 5 } }, root);
    const entries = await readSessionLog(id, root);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.type, 'user');
    assert.equal(typeof entries[0]!.ts, 'number');
    assert.deepEqual(entries[1]!.meta, { tool: 'run_command', ms: 5 });
    const raw = await readFile(sessionLogPath(id, root), 'utf8');
    assert.equal(raw.split('\n').filter(Boolean).length, 2, 'one JSON object per line');
  });
});

test('parseSessionLog skips corrupt lines instead of failing', () => {
  const entries = parseSessionLog([
    JSON.stringify({ ts: 1, type: 'user', text: 'ok' }),
    'not json at all',
    JSON.stringify({ ts: 2, type: 'assistant' }),
    JSON.stringify({ type: 'assistant', text: 'no ts' }),
    JSON.stringify({ ts: 3, type: 'system', text: 'fine' }),
    '',
  ].join('\n'));
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.text, 'ok');
  assert.equal(entries[1]!.type, 'system');
});

test('foldLogToMessages drops meta entries and keeps conversation roles', () => {
  const messages = foldLogToMessages([
    { ts: 1, type: 'user', text: 'q' },
    { ts: 2, type: 'meta', text: 'checkpoint' },
    { ts: 3, type: 'assistant', text: 'a' },
  ]);
  assert.deepEqual(messages, [{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }]);
});

test('loadFullTranscript survives compaction applied to the snapshot', async () => {
  await withTemp(async (root) => {
    const id = await seedLogSession(root);
    const full = await loadFullTranscript(id, root);
    assert.deepEqual(full, [
      { role: 'user', text: 'first question' },
      { role: 'assistant', text: 'first answer' },
      { role: 'tool', text: 'read_file src/a.ts' },
      { role: 'user', text: 'follow-up' },
    ]);
  });
});

test('fork copies full uncompacted history and records lineage', async () => {
  await withTemp(async (root) => {
    const id = await seedLogSession(root);
    const result = await forkSession(id, { cwd: root });
    assert.ok(result);
    assert.equal(result.from, id);
    assert.equal(result.copied, 4, 'full log replayed, not the compacted snapshot');
    assert.match(result.session.title, /parent \(fork\)/);
    assert.equal(result.session.forkedFrom, id);
    assert.notEqual(result.session.id, id);
    // The fork's own log is written for further forking.
    const forkLog = await readSessionLog(result.session.id, root);
    assert.equal(forkLog.length, 4);
    // Snapshot load works too.
    const stored = await loadSession(result.session.id, root);
    assert.ok(stored);
    assert.equal(stored!.messages.length, 4);
  });
});

test('fork with up-to cut point forks a prefix', async () => {
  await withTemp(async (root) => {
    const id = await seedLogSession(root);
    const result = await forkSession(id, { cwd: root, upTo: 2 });
    assert.equal(result!.copied, 2);
    assert.equal((await loadSession(result!.session.id, root))!.messages.length, 2);
    const fromEnd = await forkSession(id, { cwd: root, upTo: -1 });
    assert.equal(fromEnd!.copied, 3, 'negative cut forks from the end');
  });
});

test('fork falls back to the compacted snapshot + summary when no log exists', async () => {
  await withTemp(async (root) => {
    const id = newSessionId();
    await saveSession({
      id,
      title: 'legacy',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [{ role: 'user', text: 'kept' }],
      summary: '[older turns]',
      version: SESSION_SCHEMA_VERSION,
    }, root);
    const result = await forkSession(id, { cwd: root });
    assert.ok(result);
    assert.equal(result.copied, 2, 'summary rides along as a system message');
    assert.equal(result.session.messages[0]!.role, 'system');
    assert.equal(result.session.messages[0]!.text, '[older turns]');
  });
});

test('fork of an unknown session returns undefined; ids are validated', async () => {
  await withTemp(async (root) => {
    assert.equal(await forkSession('nope-not-here', { cwd: root }), undefined);
    assert.throws(() => sessionLogPath('../escape', root), /Invalid session id/);
  });
});
