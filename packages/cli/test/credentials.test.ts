import { strict as assert } from 'node:assert';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import {
  credentialsPath,
  deleteCredential,
  injectCredentialsIntoEnv,
  readCredentials,
  resolveCredential,
  saveCredential,
} from '../src/credentials.js';

async function withHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(`${tmpdir()}/af-creds-`);
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('credentials round-trip with 0600 permissions', async () => {
  await withHome(async (home) => {
    const path = await saveCredential({ entry: 'openrouter', env: 'OPENROUTER_API_KEY', key: 'sk-or-test' }, home);
    assert.match(path, /\.agentforge\/credentials\.json$/);
    const info = await stat(path);
    assert.equal(info.mode & 0o777, 0o600, 'file is owner-read-write only');
    const file = await readCredentials(home);
    assert.equal(file.entries.openrouter, 'sk-or-test');
    assert.equal(file.envs.OPENROUTER_API_KEY, 'sk-or-test');
  });
});

test('resolveCredential prefers the environment over the file', async () => {
  await withHome(async (home) => {
    await saveCredential({ env: 'TEST_PROVIDER_KEY', key: 'file-key' }, home);
    assert.equal(await resolveCredential('TEST_PROVIDER_KEY', {}, home), 'file-key');
    assert.equal(await resolveCredential('TEST_PROVIDER_KEY', { TEST_PROVIDER_KEY: 'env-key' }, home), 'env-key');
    assert.equal(await resolveCredential('UNSTORED_KEY', {}, home), undefined);
  });
});

test('injectCredentialsIntoEnv fills gaps without overwriting', async () => {
  await withHome(async (home) => {
    await saveCredential({ env: 'A_KEY', key: 'a-value' }, home);
    await saveCredential({ env: 'B_KEY', key: 'b-value' }, home);
    const env: Record<string, string | undefined> = { B_KEY: 'already-set' };
    const injected = await injectCredentialsIntoEnv(env as NodeJS.ProcessEnv, home);
    assert.equal(injected, 1);
    assert.equal(env.A_KEY, 'a-value');
    assert.equal(env.B_KEY, 'already-set', 'environment wins');
  });
});

test('deleteCredential removes entries and deletes the file when empty', async () => {
  await withHome(async (home) => {
    await saveCredential({ env: 'ONLY_KEY', key: 'v' }, home);
    assert.equal(await deleteCredential({ env: 'ONLY_KEY' }, home), true);
    assert.equal(await deleteCredential({ env: 'ONLY_KEY' }, home), false);
    await assert.rejects(() => stat(credentialsPath(home)));
  });
});

test('saveCredential without entry or env throws', async () => {
  await withHome(async (home) => {
    await assert.rejects(() => saveCredential({ key: 'v' }, home), /entry name and\/or an env/);
  });
});
