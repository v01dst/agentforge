import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  addProviderEntry,
  readProviderEntries,
  removeProviderEntry,
  validateProviderEntry,
} from '../src/providers-store.js';
import { mergeProviderEntries } from '../src/config.js';
import { buildModelReport } from '../src/session.js';

async function tempProject(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'agentforge-providers-'));
}

test('addProviderEntry writes the sidecar file and enforces uniqueness', async () => {
  const workspace = await tempProject();
  try {
    const first = await addProviderEntry('myproxy', { protocol: 'openai-compatible', baseUrl: 'https://proxy.example/v1', model: 'vendor/model-x', apiKeyEnv: 'MYPROXY_KEY' }, workspace);
    assert.equal(first.replaced, false);
    const parsed = JSON.parse(await readFile(join(workspace, '.agentforge', 'providers.json'), 'utf8')) as { providers: Array<{ name: string; protocol: string }> };
    assert.equal(parsed.providers[0]?.name, 'myproxy');
    assert.equal(parsed.providers[0]?.protocol, 'openai-compatible');
    assert.equal(JSON.stringify(parsed).includes('MYPROXY_KEY'), true, 'stores env var NAME only');

    await assert.rejects(
      () => addProviderEntry('myproxy', { protocol: 'openai' }, workspace),
      /already exists/,
    );
    const replaced = await addProviderEntry('myproxy', { protocol: 'openai' , force: true }, workspace);
    assert.equal(replaced.replaced, true);
    assert.equal(replaced.entry.protocol, 'openai');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('removeProviderEntry reports missing endpoints honestly', async () => {
  const workspace = await tempProject();
  try {
    assert.equal(await removeProviderEntry('ghost', workspace), false);
    await addProviderEntry('gone-soon', { protocol: 'google' }, workspace);
    assert.equal(await removeProviderEntry('gone-soon', workspace), true);
    assert.deepEqual(await readProviderEntries(workspace), []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('validateProviderEntry rejects incomplete or malformed definitions', () => {
  assert.throws(() => validateProviderEntry({ name: 'p', protocol: 'openai-compatible' }), /requires --base-url/);
  assert.throws(() => validateProviderEntry({ name: 'p', protocol: 'carrier-pigeon' }), /protocol must be one of/);
  assert.throws(() => validateProviderEntry({ name: '9bad', protocol: 'openai' }), /must start with a letter/);
  assert.throws(() => validateProviderEntry({ name: 'p', protocol: 'openai', apiKeyEnv: 42 }), /apiKeyEnv must be a variable name/);
  const ok = validateProviderEntry({ name: 'local-ollama', protocol: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' });
  assert.equal(ok.apiKeyEnv, undefined);
});

test('loadConfig merges sidecar endpoints without shadowing config names', () => {
  const config = { providers: [{ name: 'from-config' }, 'mock'] };
  const sidecar = [
    { name: 'myproxy', protocol: 'openai-compatible', baseUrl: 'https://x.example/v1' },
    { name: 'from-config', protocol: 'anthropic' },
  ];
  const merged = mergeProviderEntries(config, sidecar);
  const names = (merged.providers ?? []).map((entry) => typeof entry === 'string' ? entry : entry.name);
  assert.deepEqual(names, ['from-config', 'mock', 'myproxy']);
  const proxy = (merged.providers ?? []).find((entry) => typeof entry !== 'string' && entry.name === 'myproxy') as Record<string, unknown>;
  assert.equal(proxy.protocol, 'openai-compatible');
});

test('buildModelReport surfaces managed endpoint rows with readiness', () => {
  const rows = buildModelReport([
    { name: 'myproxy', protocol: 'openai-compatible', baseUrl: 'https://proxy.example/v1', apiKeyEnv: 'MYPROXY_KEY', model: 'vendor/model-x' },
    { name: 'broken-proxy', protocol: 'openai-compatible' },
  ], { MYPROXY_KEY: 'set' });
  const byName = new Map(rows.map((row) => [row.provider, row]));
  const proxy = byName.get('myproxy');
  assert.equal(proxy?.source, 'config');
  assert.equal(proxy?.protocol, 'openai-compatible');
  assert.equal(proxy?.ready, true);
  assert.equal(proxy?.defaultModel, 'vendor/model-x');
  assert.equal(byName.get('broken-proxy')?.ready, false);
});
