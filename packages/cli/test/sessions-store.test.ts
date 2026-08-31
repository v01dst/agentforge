import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMPACT_KEEP_RECENT,
  COMPACT_THRESHOLD_MESSAGES,
  compactTranscript,
  deleteSession,
  listSessions,
  loadSession,
  locateSession,
  newSessionId,
  pruneSessions,
  renameSession,
  saveSession,
  type StoredSession,
} from '../src/sessions/store.js';

test('session store round-trips save/load/list/delete', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agentforge-sessions-'));
  try {
    const id = newSessionId();
    const session: StoredSession = {
      id,
      title: 'fix the login bug',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        { role: 'user', text: 'fix the login bug' },
        { role: 'assistant', text: 'Patched auth.ts and tests pass.' },
      ],
      provider: 'mock',
      model: 'mock',
    };
    await saveSession(session, project);

    const loaded = await loadSession(id, project);
    assert.ok(loaded);
    assert.equal(loaded?.title, 'fix the login bug');
    assert.equal(loaded?.messages.length, 2);

    const all = await listSessions(project);
    assert.equal(all.length, 1);
    assert.equal(all[0]?.id, id);
    assert.equal(all[0]?.messages, 2);
    assert.match(await readFile(join(project, '.agentforge', 'sessions', `${id}.json`), 'utf8'), /login bug/);

    assert.equal(await deleteSession(id, project), true);
    assert.equal(await deleteSession(id, project), false);
    assert.equal((await listSessions(project)).length, 0);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('listSessions merges global + project stores; invalid ids are rejected on save', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agentforge-sessions-'));
  const fakeHome = await mkdtemp(join(tmpdir(), 'agentforge-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const base = { title: 't', createdAt: '', updatedAt: new Date().toISOString(), messages: [{ role: 'user' as const, text: 'hi' }] };
    await saveSession({ ...base, id: 's-global-1' }, project, true);
    await saveSession({ ...base, id: 's-proj-1' }, project, false);
    const all = await listSessions(project);
    assert.deepEqual(all.map((entry) => entry.id).sort(), ['s-global-1', 's-proj-1']);

    await assert.rejects(() => saveSession({ ...base, id: '../escape' }, project), /Invalid session id/);
    void newSessionId;
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(fakeHome, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test('renameSession updates the title in whichever store holds the session', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agentforge-sessions-'));
  const fakeHome = await mkdtemp(join(tmpdir(), 'agentforge-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const base = { title: 'old', createdAt: '', updatedAt: new Date().toISOString(), messages: [{ role: 'user' as const, text: 'hi' }] };
    await saveSession({ ...base, id: 's-proj-2' }, project, false);
    await saveSession({ ...base, id: 's-glob-2' }, project, true);

    assert.equal(await renameSession('s-proj-2', '  fixed the bug  ', project), true);
    const projectSession = await loadSession('s-proj-2', project, false);
    assert.equal(projectSession?.title, 'fixed the bug');

    // Not in project store -> found and renamed in the global store.
    assert.equal(await renameSession('s-glob-2', 'global title', project), true);
    assert.equal((await loadSession('s-glob-2', project, true))?.title, 'global title');

    assert.equal(await renameSession('s-missing', 'nope', project), false);
    await assert.rejects(() => renameSession('s-proj-2', '   ', project), /cannot be empty/);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(fakeHome, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test('pruneSessions removes by age and count, honours dry-run, returns removed ids', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agentforge-sessions-'));
  try {
    const base = { title: 't', createdAt: '', messages: [{ role: 'user' as const, text: 'hi' }] };
    const day = 24 * 60 * 60 * 1000;
    const write = async (id: string, ageDays: number) => {
      await saveSession({ ...base, id, updatedAt: new Date(Date.now() - ageDays * day).toISOString() } as StoredSession, project);
    };
    await write('s-old-1', 10);
    await write('s-old-2', 8);
    await write('s-mid-1', 3);
    await write('s-new-1', 0);

    const dryRun = await pruneSessions({ cwd: project, olderThanDays: 5, dryRun: true });
    assert.deepEqual([...dryRun].sort(), ['s-old-1', 's-old-2']);
    assert.equal((await listSessions(project)).length, 4);

    const removed = await pruneSessions({ cwd: project, olderThanDays: 5 });
    assert.equal(removed.length, 2);
    assert.equal((await listSessions(project)).length, 2);

    const byCount = await pruneSessions({ cwd: project, keep: 1 });
    assert.equal(byCount.length, 1);
    const survivors = await listSessions(project);
    assert.equal(survivors.length, 1);
    assert.equal(survivors[0]?.id, 's-new-1');
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('compactTranscript keeps the recent tail and summarizes older turns', () => {
  const long = Array.from({ length: COMPACT_THRESHOLD_MESSAGES + 10 }, (_, index) => ({
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    text: `message ${index}`,
  }));
  const result = compactTranscript(long);
  assert.equal(result.messages.length, COMPACT_KEEP_RECENT);
  assert.equal(result.messages[0]?.text, `message ${long.length - COMPACT_KEEP_RECENT}`);
  assert.ok(result.summary?.includes('message 0'));
  assert.ok(result.summary?.startsWith('[earlier conversation]'));

  const short = [{ role: 'user' as const, text: 'only one' }];
  const untouched = compactTranscript(short);
  assert.equal(untouched.messages.length, 1);
  assert.equal(untouched.summary, undefined);
});

test('compactTranscript clamps oversized summary lines', () => {
  const longText = 'x'.repeat(400);
  const long = Array.from({ length: COMPACT_THRESHOLD_MESSAGES + 5 }, (_, index) => ({
    role: 'user' as const,
    text: index === 0 ? longText : `m${index}`,
  }));
  const result = compactTranscript(long);
  assert.ok(result.summary);
  assert.ok(result.summary!.includes('…'));
  assert.ok(result.summary!.length < 400 * 20);
});

test('corrupted session files are skipped by list/load rather than crashing', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agentforge-sessions-'));
  try {
    const dir = join(project, '.agentforge', 'sessions');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 's-broken.json'), '{not json', 'utf8');
    const base = { title: 't', createdAt: '', updatedAt: new Date().toISOString(), messages: [{ role: 'user' as const, text: 'hi' }] };
    await saveSession({ ...base, id: 's-good-1' } as StoredSession, project);
    const all = await listSessions(project);
    assert.deepEqual(all.map((entry) => entry.id), ['s-good-1']);
    assert.equal(await loadSession('s-broken', project), undefined);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('locateSession reports the scope a session was found in', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agentforge-sessions-'));
  const fakeHome = await mkdtemp(join(tmpdir(), 'agentforge-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const base = { title: 't', createdAt: '', updatedAt: new Date().toISOString(), messages: [{ role: 'user' as const, text: 'hi' }] };
    await saveSession({ ...base, id: 's-glob-3' }, project, true);
    const found = await locateSession('s-glob-3', project);
    assert.ok(found);
    assert.equal(found.global, true);
    assert.equal((await locateSession('s-none', project)), undefined);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(fakeHome, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});
