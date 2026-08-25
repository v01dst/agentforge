import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import {
  addRecentProject,
  detectProject,
  mergeProviderEntries,
  readGlobalConfig,
  resolveActiveProvider,
  RECENT_PROJECT_LIMIT,
  setGlobalDefault,
  validateProviderConnection,
  writeGlobalConfig,
} from '../src/global-runtime.js';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentforge-global-'));
});

afterEach(() => {
  delete process.env.AGENTFORGE_PROVIDER;
  delete process.env.AGENTFORGE_MODEL;
});

test('read/write roundtrip with defaults', async () => {
  const initial = await readGlobalConfig(dir);
  assert.equal(initial.sessionHistory, true);
  assert.deepEqual(initial.providers, []);
  assert.deepEqual(initial.recentProjects, []);
  const config = {
    defaultProvider: 'openai',
    defaultModel: 'gpt-4o',
    providers: [{ name: 'main', protocol: 'openai' as const, apiKeyEnv: 'OPENAI_API_KEY' }],
    recentProjects: ['/tmp/proj'],
    sessionHistory: false,
  };
  await writeGlobalConfig(config, dir);
  assert.deepEqual(await readGlobalConfig(dir), config);
});

test('merge precedence: project beats global on name collision', () => {
  const merged = mergeProviderEntries(
    [
      { name: 'shared', protocol: 'openai', apiKeyEnv: 'GLOBAL_KEY' },
      { name: 'only-global', protocol: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    ],
    [{ name: 'shared', protocol: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', apiKeyEnv: 'LOCAL_KEY' }],
  );
  const shared = merged.find((entry) => entry.name === 'shared');
  assert.ok(shared);
  assert.equal(shared.scope, 'project');
  assert.equal(shared.protocol, 'openai-compatible');
  assert.equal(shared.apiKeyEnv, 'LOCAL_KEY');
  assert.ok(merged.find((entry) => entry.name === 'only-global')?.scope === 'global');
});

test('resolveActiveProvider env override wins over global defaults', async () => {
  const bare = await resolveActiveProvider(dir);
  assert.deepEqual(bare, { provider: 'mock', model: undefined, source: 'default' });
  await setGlobalDefault('openai', 'gpt-4o', dir);
  const global = await resolveActiveProvider(dir);
  assert.equal(global.source, 'global');
  assert.equal(global.provider, 'openai');
  assert.equal(global.model, 'gpt-4o');
  process.env.AGENTFORGE_PROVIDER = 'anthropic';
  process.env.AGENTFORGE_MODEL = 'claude-x';
  const env = await resolveActiveProvider(dir);
  assert.equal(env.source, 'env');
  assert.equal(env.provider, 'anthropic');
  assert.equal(env.model, 'claude-x');
});

test('validateProviderConnection missing-env case (no network)', async () => {
  delete process.env.AGENTFORGE_TEST_KEY;
  const result = await validateProviderConnection({ name: 'main', protocol: 'openai', apiKeyEnv: 'AGENTFORGE_TEST_KEY' });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /API key missing/);
  assert.match(result.reason ?? '', /AGENTFORGE_TEST_KEY/);
});

test('validateProviderConnection ok when env present; unknown protocol rejected', async () => {
  process.env.AGENTFORGE_TEST_KEY = 'sk-test';
  const ok = await validateProviderConnection({ name: 'main', protocol: 'openai', apiKeyEnv: 'AGENTFORGE_TEST_KEY' });
  assert.deepEqual(ok, { ok: true });
  const badProtocol = await validateProviderConnection({ name: 'x', protocol: 'wat' as never, apiKeyEnv: 'AGENTFORGE_TEST_KEY' });
  assert.equal(badProtocol.ok, false);
  // openai-compatible localhost without key is fine offline
  const local = await validateProviderConnection({ name: 'llamacpp', protocol: 'openai-compatible', baseUrl: 'http://localhost:8080/v1', apiKeyEnv: 'NOPE_UNSET' });
  assert.equal(local.ok, true);
});

test('detectProject true and false cases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentforge-proj-'));
  const nested = join(root, 'deep', 'deeper');
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(nested, { recursive: true });
  const none = await detectProject(nested);
  assert.equal(none.found, false);
  await writeFile(join(root, 'agentforge.config.ts'), 'export default {};\n');
  const found = await detectProject(nested);
  assert.equal(found.found, true);
  assert.equal(found.path, root);
  assert.equal(found.configPath, join(root, 'agentforge.config.ts'));
});

test('addRecentProject dedupe, order, and cap at 10', async () => {
  for (let i = 0; i < RECENT_PROJECT_LIMIT + 2; i++) await addRecentProject(`/tmp/p${i}`, dir);
  let recent = (await readGlobalConfig(dir)).recentProjects;
  assert.equal(recent.length, RECENT_PROJECT_LIMIT);
  assert.equal(recent[0], `/tmp/p${RECENT_PROJECT_LIMIT + 1}`);
  await addRecentProject('/tmp/p5', dir);
  recent = (await readGlobalConfig(dir)).recentProjects;
  assert.equal(recent.filter((p) => p === '/tmp/p5').length, 1);
  assert.equal(recent[0], '/tmp/p5');
});
