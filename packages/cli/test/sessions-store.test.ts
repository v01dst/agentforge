import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteSession, listSessions, loadSession, newSessionId, saveSession, type StoredSession } from '../src/sessions/store.js';

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
