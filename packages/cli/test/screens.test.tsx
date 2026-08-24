import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { NewProjectScreen } from '../src/ui/screens/NewProjectScreen.js';

const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

test('NewProjectScreen renders the name prompt in step 1', async () => {
  const instance = render(React.createElement(NewProjectScreen, {}));
  await delay(60);
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /AgentForge · new project/);
  assert.match(frame, /Project name:/);
  assert.match(frame, /suggestion: my-agent/);
  instance.unmount();
});
