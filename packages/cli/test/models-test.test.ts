import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelProbe, modelsTestCommand } from '../src/commands.js';

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'af-modeltest-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('model probe names the missing credential for builtin providers', async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(() => modelProbe('openai', {}), /OPENAI_API_KEY is required/);
  } finally {
    if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
  }
});

test('model probe rejects unknown providers with guidance', async () => {
  await assert.rejects(() => modelProbe('definitely-not-real', {}), /Known builtins: openai, anthropic, google, gemini/);
});

test('model probe reports managed endpoint credential problems by variable name', async () => {
  await withTemp(async (root) => {
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      await mkdir(join(root, '.agentforge'), { recursive: true });
      await writeFile(
        join(root, '.agentforge', 'providers.json'),
        JSON.stringify({ providers: [{ name: 'myproxy', protocol: 'openai-compatible', baseUrl: 'https://proxy.example/v1', model: 'vendor/curious-7b', apiKeyEnv: 'MYPROXY_TEST_KEY' }] }, null, 2),
        'utf8',
      );
      const previous = process.env.MYPROXY_TEST_KEY;
      delete process.env.MYPROXY_TEST_KEY;
      try {
        await assert.rejects(() => modelProbe('myproxy', {}), /export MYPROXY_TEST_KEY/);
      } finally {
        if (previous !== undefined) process.env.MYPROXY_TEST_KEY = previous;
      }
    } finally {
      process.chdir(previousCwd);
    }
  });
});
