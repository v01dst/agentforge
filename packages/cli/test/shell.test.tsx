import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { Dashboard, type DashboardActions } from '../src/ui/shell/Dashboard.js';
import { ActivityIndicator } from '../src/ui/shell/Activity.js';
import { CommandPalette, type PaletteAction } from '../src/ui/shell/palette.js';

const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const noopActions: DashboardActions = {
  onChat: () => {}, onRun: () => {}, onNewProject: () => {}, onTools: () => {},
  onWorkflows: () => {}, onModels: () => {}, onTest: () => {}, onDoctor: () => {},
  onSettings: () => {}, onPalette: () => {},
};

test('Dashboard renders quick actions and settles section data', async () => {
  const instance = render(React.createElement(Dashboard, noopActions));
  assert.match(instance.lastFrame() ?? '', /Quick actions/);
  assert.match(instance.lastFrame() ?? '', /Chat with agent/);
  await delay(120);
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /Project/);
  assert.match(frame, /Recent runs/);
  instance.unmount();
});

test('ActivityIndicator shows its label', async () => {
  const instance = render(React.createElement(ActivityIndicator, { label: 'Loading tools', detail: '12/24' }));
  await delay(100);
  assert.match(instance.lastFrame() ?? '', /Loading tools/);
  assert.match(instance.lastFrame() ?? '', /12\/24/);
  instance.unmount();
});

test('CommandPalette filters items by substring', async () => {
  const actions: PaletteAction[] = [
    { id: 'chat', title: 'Chat with agent', hint: 'interactive', run: () => {} },
    { id: 'doctor', title: 'Doctor diagnostics', hint: 'checks', run: () => {} },
  ];
  const instance = render(React.createElement(CommandPalette, { actions, onClose: () => {} }));
  await delay(50);
  assert.match(instance.lastFrame() ?? '', /Chat with agent/);
  assert.match(instance.lastFrame() ?? '', /Doctor diagnostics/);
  // Type 'doc' via stdin to filter down to the doctor entry.
  instance.stdin.write('doc');
  await delay(80);
  const frame = instance.lastFrame() ?? '';
  assert.doesNotMatch(frame, /Chat with agent/);
  assert.match(frame, /Doctor diagnostics/);
  instance.unmount();
});
