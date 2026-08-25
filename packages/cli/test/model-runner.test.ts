import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDefaultProvider, resolveModelRunner } from '../src/model-runner.js';

function stripProviderEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy.OPENAI_API_KEY;
  delete copy.ANTHROPIC_API_KEY;
  delete copy.GOOGLE_API_KEY;
  delete copy.GEMINI_API_KEY;
  return copy;
}

test('detectDefaultProvider falls back to mock when no keys present', () => {
  const detected = detectDefaultProvider(stripProviderEnv(process.env));
  assert.equal(detected.provider, 'mock');
});

test('detectDefaultProvider prefers anthropic when its key is set', () => {
  const env = { ...stripProviderEnv(process.env), ANTHROPIC_API_KEY: 'sk-test' };
  const detected = detectDefaultProvider(env);
  assert.equal(detected.provider, 'anthropic');
  assert.equal(detected.model, 'claude-sonnet-4-5');
});

test('detectDefaultProvider honors explicit AGENTFORGE_PROVIDER/MODEL over key detection', () => {
  const env = {
    ...stripProviderEnv(process.env),
    OPENAI_API_KEY: 'sk-test',
    AGENTFORGE_PROVIDER: 'anthropic',
    AGENTFORGE_MODEL: 'claude-3-haiku',
  };
  const detected = detectDefaultProvider(env);
  assert.equal(detected.provider, 'anthropic');
  assert.equal(detected.model, 'claude-3-haiku');
});

test('resolveModelRunner returns a streaming runner that yields text', async () => {
  process.env.AGENTFORGE_PROVIDER = 'mock';
  try {
    const resolved = await resolveModelRunner();
    assert.equal(resolved.provider, 'mock');
    assert.equal(typeof resolved.runner, 'function');
    let text = '';
    for await (const delta of resolved.runner('hello', new AbortController().signal, { skills: [] })) {
      if (delta.text) text += delta.text;
    }
    assert.ok(text.length > 0, 'expected non-empty streamed response');
  } finally {
    delete process.env.AGENTFORGE_PROVIDER;
  }
});

test('resolveModelRunner creates an openai runner without throwing on invalid key', async () => {
  process.env.OPENAI_API_KEY = 'sk-invalid-for-test';
  try {
    const resolved = await resolveModelRunner();
    assert.equal(resolved.provider, 'openai');
    assert.equal(typeof resolved.runner, 'function');
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});
