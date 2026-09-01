import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { HelpScreen } from '../src/ui/slash/HelpScreen.js';
import { commandCatalog } from '../src/ui/slash/registry.js';

const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

test('commandCatalog enumerates the live registry with categories', () => {
  const catalog = commandCatalog();
  const names = catalog.map((entry) => entry.name);
  for (const expected of ['help', 'connect', 'providers', 'mode', 'permissions', 'skills', 'agents', 'runs', 'doctor']) {
    assert.ok(names.includes(expected), `catalog contains /${expected}`);
  }
  const mode = catalog.find((entry) => entry.name === 'mode')!;
  assert.equal(mode.category, 'config');
  assert.match(mode.description, /session mode/i);
  const permissions = catalog.find((entry) => entry.name === 'permissions')!;
  assert.deepEqual(permissions.aliases, ['posture']);
});

test('HelpScreen renders a categorized cheat-sheet; esc closes', async () => {
  let back = false;
  const instance = render(React.createElement(HelpScreen, { onBack: () => { back = true; } }));
  await delay(30);
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /Command cheat-sheet/);
  assert.match(frame, /Session basics/);
  assert.match(frame, /Configuration/);
  assert.match(frame, /\/help/);
  assert.match(frame, /\/permissions/);
  assert.match(frame, /Everyday flow/);
  instance.stdin.write('\u001b');
  await delay(60);
  if (!back) {
    // Some terminals/CI transports split the escape byte; retry once.
    instance.stdin.write('\u001b');
    await delay(80);
  }
  assert.equal(back, true, 'esc triggers onBack');
  instance.unmount();
});
