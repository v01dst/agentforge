import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeProfileName,
  getProfile,
  listProfiles,
  removeProfile,
  resolveProfileToEnvValues,
  saveProfile,
  setActiveProfile,
} from '../src/profiles/profiles.js';

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'af-profiles-'));
  const previousHome = process.env.HOME;
  process.env.HOME = root; // global store must live inside the sandbox
  try {
    await fn(root);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
}

test('profiles round-trip through the global store', async () => {
  await withTemp(async (root) => {
    assert.deepEqual(await listProfiles(root), []);
    const saved = await saveProfile({ name: 'deep', provider: 'anthropic', model: 'claude-sonnet', permissionMode: 'workspace-write' }, { scope: 'global' }, root);
    assert.match(saved.path, /\.agentforge\/profiles\.json$/);
    assert.equal(saved.replaced, false);
    const again = await saveProfile({ name: 'deep', provider: 'anthropic', model: 'claude-opus' }, { scope: 'global' }, root);
    assert.equal(again.replaced, true, 'same-name save replaces');
    const list = await listProfiles(root);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.model, 'claude-opus');
  });
});

test('project profiles shadow global ones by name', async () => {
  await withTemp(async (root) => {
    await saveProfile({ name: 'fast', provider: 'openai', model: 'gpt-4o-mini' }, { scope: 'global' }, root);
    await saveProfile({ name: 'fast', provider: 'anthropic', model: 'claude-haiku' }, { scope: 'project' }, root);
    await saveProfile({ name: 'only-global', provider: 'mock' }, { scope: 'global' }, root);
    const list = await listProfiles(root);
    assert.equal(list.length, 2, 'shadowed name merged');
    const fast = await getProfile('fast', root);
    assert.equal(fast!.provider, 'anthropic');
    assert.equal(fast!.model, 'claude-haiku');
  });
});

test('active-profile flag is stored and reported (project flag wins)', async () => {
  await withTemp(async (root) => {
    await saveProfile({ name: 'deep', provider: 'anthropic' }, { scope: 'global' }, root);
    await setActiveProfile('deep', 'global', root);
    assert.equal(await activeProfileName(root), 'deep');
    await saveProfile({ name: 'fast', provider: 'openai' }, { scope: 'project' }, root);
    await setActiveProfile('fast', 'project', root);
    assert.equal(await activeProfileName(root), 'fast');
  });
});

test('removeProfile deletes from whichever store holds it and clears the active flag', async () => {
  await withTemp(async (root) => {
    await saveProfile({ name: 'gone', provider: 'mock' }, { scope: 'global' }, root);
    await setActiveProfile('gone', 'global', root);
    assert.equal(await removeProfile('gone', root), true);
    assert.equal(await removeProfile('gone', root), false);
    assert.deepEqual(await listProfiles(root), []);
    assert.equal(await activeProfileName(root), undefined);
  });
});

test('resolveProfileToEnvValues: explicit environment wins over the profile', () => {
  const profile = { name: 'p', provider: 'anthropic', model: 'claude-sonnet', permissionMode: 'read-only' as const };
  const resolved = resolveProfileToEnvValues(profile, { AGENTFORGE_PROVIDER: 'openai' });
  assert.equal(resolved.provider, 'openai', 'env wins');
  assert.equal(resolved.model, 'claude-sonnet', 'profile fills the gap');
  assert.equal(resolved.permissionMode, 'read-only');
  const untouched = resolveProfileToEnvValues(profile, {});
  assert.equal(untouched.provider, 'anthropic');
  assert.equal(untouched.model, 'claude-sonnet');
});

test('invalid profiles are rejected loudly', async () => {
  await withTemp(async (root) => {
    await assert.rejects(
      () => saveProfile({ name: 'bad mode', permissionMode: 'trusted' as never } as never, { scope: 'global' }, root),
      /Invalid profile/,
    );
    await assert.rejects(
      () => saveProfile({ name: 'bad posture', permissionMode: 'chaos' as never } as never, { scope: 'global' }, root),
      /Invalid profile/,
    );
  });
});
