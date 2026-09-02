import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EzStart } from '../src/ui/shell/EzStart.js';

const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

test('EzStart welcome screen offers three paths', async () => {
  const instance = render(React.createElement(EzStart, { onComplete: () => {}, onSkip: () => {} }));
  await delay(30);
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /Welcome to AgentForge/);
  assert.match(frame, /Quick start/);
  assert.match(frame, /Custom provider/);
  assert.match(frame, /Skip for now/);
  instance.unmount();
});

test('EzStart preset flow: filter, pick DeepSeek, masked key, model from endpoint, save', async () => {
  const home = await mkdtemp(`${tmpdir()}/af-ezstart-`);
  const project = await mkdtemp(`${tmpdir()}/af-ezstart-p-`);
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(project);
  let done: { name: string; model: string } | undefined;
  try {
    // Fake the provider endpoint: DeepSeek-style { data: [...] } response.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    try {
      const instance = render(React.createElement(EzStart, {
        onComplete: (result) => { done = result; },
        onSkip: () => {},
      }));
      await delay(30);
      instance.stdin.write('1'); // quick start
      await delay(30);
      instance.stdin.write('deepseek'); // fuzzy filter
      await delay(30);
      instance.stdin.write('\r'); // pick DeepSeek (first match)
      await delay(30);
      instance.stdin.write('sk-ds-secret'); // masked key entry
      await delay(60);
      const maskedFrame = instance.lastFrame() ?? '';
      assert.match(maskedFrame, /•+/, 'key entry is masked with bullets');
      assert.ok(!maskedFrame.includes('sk-ds-secret'), 'raw key is never rendered');
      instance.stdin.write('\r'); // submit key → endpoint fetch
      // Poll until the model PICKER renders ('↑/↓ pick' only shows when the
      // fetched list resolved — the loading frame shows the typed default too).
      let frame = '';
      for (let i = 0; i < 40; i += 1) {
        await delay(50);
        frame = instance.lastFrame() ?? '';
        if (frame.includes('↑/↓ pick')) break;
      }
      assert.match(frame, /deepseek-v4-flash/, 'fetched model list rendered');
      assert.ok(!frame.includes('sk-ds-secret'), 'raw key is never rendered');
      // deepseek-v4-flash is preselected (preset default position); enter confirms.
      instance.stdin.write('\r');
      for (let i = 0; i < 40; i += 1) {
        await delay(50);
        frame = instance.lastFrame() ?? '';
        if (frame.includes('ready')) break;
      }
      assert.match(frame, /ready/, 'done state rendered');
      instance.unmount();

      // Provider entry persisted to the project store.
      const providers = JSON.parse(await readFile(join(project, '.agentforge', 'providers.json'), 'utf8')) as { providers: Array<{ name: string; model: string; protocol: string }> };
      const deepseek = providers.providers.find((entry) => entry.name === 'deepseek');
      assert.ok(deepseek, 'deepseek entry saved');
      assert.equal(deepseek!.model, 'deepseek-v4-flash');
      assert.equal(deepseek!.protocol, 'openai-compatible');
      // Credential persisted to the home store with 0600.
      const creds = JSON.parse(await readFile(join(home, '.agentforge', 'credentials.json'), 'utf8')) as { entries: Record<string, string>; envs: Record<string, string> };
      assert.equal(creds.entries.deepseek, 'sk-ds-secret');
      assert.equal(creds.envs.DEEPSEEK_API_KEY, 'sk-ds-secret');
      const info = await stat(join(home, '.agentforge', 'credentials.json'));
      assert.equal(info.mode & 0o777, 0o600);
      assert.deepEqual(done, { name: 'deepseek', model: 'deepseek-v4-flash' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    process.chdir(previousCwd);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test('EzStart custom flow: name → base URL → key → model id → saved', async () => {
  const home = await mkdtemp(`${tmpdir()}/af-ezstart-c-`);
  const project = await mkdtemp(`${tmpdir()}/af-ezstart-cp-`);
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(project);
  try {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ id: 'glm-5.3' }] }), { status: 200 })) as typeof fetch;
    try {
      const instance = render(React.createElement(EzStart, { onComplete: () => {}, onSkip: () => {} }));
      await delay(30);
      instance.stdin.write('2'); // custom
      await delay(30);
      instance.stdin.write('my-gateway');
      await delay(60);
      instance.stdin.write('\r');
      await delay(60);
      instance.stdin.write('https://api.mygw.com/v1');
      await delay(60);
      instance.stdin.write('\r');
      await delay(60);
      instance.stdin.write('gw-key-123');
      await delay(60);
      instance.stdin.write('\r');
      await delay(60);
      instance.stdin.write('glm-5.3'); // model id field (4/4)
      await delay(60);
      instance.stdin.write('\r'); // save directly
      let frame = '';
      for (let i = 0; i < 40; i += 1) {
        await delay(50);
        frame = instance.lastFrame() ?? '';
        if (frame.includes('my-gateway ready (glm-5.3)')) break;
      }
      assert.match(frame, /my-gateway ready \(glm-5\.3\)/);
      instance.unmount();
      const providers = JSON.parse(await readFile(join(project, '.agentforge', 'providers.json'), 'utf8')) as { providers: Array<{ name: string; baseUrl?: string; apiKeyEnv?: string }> };
      const gateway = providers.providers.find((entry) => entry.name === 'my-gateway');
      assert.ok(gateway, 'custom entry saved');
      assert.equal(gateway!.baseUrl, 'https://api.mygw.com/v1');
      const creds = JSON.parse(await readFile(join(home, '.agentforge', 'credentials.json'), 'utf8')) as { envs: Record<string, string> };
      assert.equal(Object.values(creds.envs)[0], 'gw-key-123');
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    process.chdir(previousCwd);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test('EzStart skip calls onSkip', async () => {
  let skipped = false;
  const instance = render(React.createElement(EzStart, { onComplete: () => {}, onSkip: () => { skipped = true; } }));
  await delay(30);
  instance.stdin.write('s');
  await delay(30);
  assert.equal(skipped, true);
  instance.unmount();
});


test('EzStart: Esc on the welcome screen skips; Esc at model step restarts the picker', async () => {
  let skipped = false;
  const instance = render(React.createElement(EzStart, { onComplete: () => {}, onSkip: () => { skipped = true; } }));
  await delay(30);
  instance.stdin.write('\u001b'); // esc at welcome = skip
  await delay(40);
  assert.equal(skipped, true, 'welcome esc triggers onSkip');
  instance.unmount();

  const home2 = await mkdtemp(`${tmpdir()}/af-ezesc-`);
  const project = await mkdtemp(`${tmpdir()}/af-ezesc-p-`);
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = home2;
  process.chdir(project);
  try {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] }), { status: 200 })) as typeof fetch;
    try {
      const instance2 = render(React.createElement(EzStart, { onComplete: () => {}, onSkip: () => {} }));
      await delay(30);
      instance2.stdin.write('1');
      await delay(40);
      instance2.stdin.write('deepseek');
      await delay(40);
      instance2.stdin.write('\r');
      await delay(40);
      instance2.stdin.write('sk-key');
      await delay(40);
      instance2.stdin.write('\r');
      await delay(150); // model picker renders
      instance2.stdin.write('\u001b'); // esc at model step
      await delay(40);
      const frame = instance2.lastFrame() ?? '';
      assert.match(frame, /Pick a provider/, 'esc restarts the picker');
      instance2.unmount();
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    process.chdir(previousCwd);
    await rm(home2, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});
