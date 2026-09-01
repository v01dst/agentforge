import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { ModelsScreen } from '../src/ui/screens/ModelsScreen.js';
import { SettingsScreen } from '../src/ui/screens/SettingsScreen.js';
import { HelpOverlay, SHORTCUTS } from '../src/ui/screens/HelpOverlay.js';

const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

test('ModelsScreen renders stubbed model rows and endpoint list', async () => {
  const instance = render(React.createElement(ModelsScreen, {
    rows: [{
      provider: 'openai',
      description: 'OpenAI chat completions',
      defaultModel: 'gpt-4o-mini',
      envVars: ['OPENAI_API_KEY'],
      ready: true,
      source: 'builtin',
    }],
    endpoints: [{ name: 'local-llm', protocol: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', apiKeyEnv: 'LOCAL_KEY' }],
  }));
  await delay(40);
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /Models/);
  assert.match(frame, /Endpoints/);
  assert.match(frame, /openai/);
  await delay(120); // let useInput handlers attach before sending keys
  instance.stdin.write('\u001b[C'); // right arrow -> Endpoints tab
  await delay(80);
  assert.match(instance.lastFrame() ?? '', /local-llm/);
  assert.match(instance.lastFrame() ?? '', /LOCAL_KEY/); // env var NAME only
  instance.unmount();
});

test('SettingsScreen renders providers and permission modes', async () => {
  const instance = render(React.createElement(SettingsScreen, {}));
  await delay(40);
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /Session Settings/);
  for (const provider of ['openai', 'anthropic', 'google', 'gemini']) {
    assert.match(frame, new RegExp(provider));
  }
  for (const mode of ['read-only', 'ask', 'workspace-write', 'trusted']) {
    assert.match(frame, new RegExp(mode));
  }
  assert.match(frame, /Credentials are never written to disk/);
  instance.unmount();
});

test('HelpOverlay renders its sections and exports SHORTCUTS with CLI equivalents', async () => {
  const instance = render(React.createElement(HelpOverlay, {}));
  await delay(40);
  const frame = instance.lastFrame() ?? '';
  for (const section of ['Navigation', 'Chat', 'Shortcuts', 'CLI equivalents']) {
    assert.match(frame, new RegExp(section));
  }
  assert.match(frame, /agentforge chat/);
  instance.unmount();
  assert.ok(SHORTCUTS.length > 0);
  assert.ok(SHORTCUTS.some((shortcut) => shortcut.cli === 'agentforge chat'));
});
