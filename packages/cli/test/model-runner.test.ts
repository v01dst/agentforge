import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { saveCredential } from '../src/credentials.js';
import { detectDefaultProvider, detectDefaultProviderWithCredentials, resolveModelRunner } from '../src/model-runner.js';

function stripProviderEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy.OPENAI_API_KEY;
  delete copy.ANTHROPIC_API_KEY;
  delete copy.GOOGLE_API_KEY;
  delete copy.GEMINI_API_KEY;
  delete copy.AGENTFORGE_PROVIDER;
  delete copy.AGENTFORGE_MODEL;
  return copy;
}

test('detectDefaultProvider returns undefined when nothing is configured (mock removed)', () => {
  const detected = detectDefaultProvider(stripProviderEnv(process.env));
  assert.equal(detected, undefined);
});

test('detectDefaultProvider prefers anthropic when its key is set', () => {
  const detected = detectDefaultProvider({ ...stripProviderEnv(process.env), ANTHROPIC_API_KEY: 'sk-test' });
  assert.equal(detected!.provider, 'anthropic');
  assert.equal(detected!.model, 'claude-opus-5');
});

test('detectDefaultProvider honors explicit AGENTFORGE_PROVIDER/MODEL over key detection', () => {
  const detected = detectDefaultProvider({
    ...stripProviderEnv(process.env),
    OPENAI_API_KEY: 'sk-test',
    AGENTFORGE_PROVIDER: 'anthropic',
    AGENTFORGE_MODEL: 'claude-3-haiku',
  });
  assert.equal(detected!.provider, 'anthropic');
  assert.equal(detected!.model, 'claude-3-haiku');
});

test('credential-aware detection finds stored keys without env vars', async () => {
  const home = await mkdtemp(`${tmpdir()}/af-mr-`);
  try {
    await saveCredential({ env: 'ANTHROPIC_API_KEY', key: 'stored-key' }, home);
    const detected = await detectDefaultProviderWithCredentials(stripProviderEnv(process.env), home as unknown as string);
    assert.equal(detected!.provider, 'anthropic');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('resolveModelRunner returns undefined with no provider configured', async () => {
  const home = await mkdtemp(`${tmpdir()}/af-mr2-`);
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(home); // empty home: no credentials store
  try {
    const resolved = await resolveModelRunner();
    assert.equal(resolved, undefined);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    process.chdir(previousCwd);
    await rm(home, { recursive: true, force: true });
  }
});

test('resolveModelRunner creates an openai runner without throwing on invalid key', async () => {
  process.env.OPENAI_API_KEY = 'sk-invalid-for-test';
  try {
    const resolved = await resolveModelRunner();
    assert.equal(resolved!.provider, 'openai');
    assert.equal(typeof resolved!.runner, 'function');
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});
