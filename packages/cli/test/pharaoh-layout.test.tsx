import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { ChatHome } from '../src/ui/shell/ChatHome.js';
import type { TurnRunner } from '../src/ui/turn.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const runner: TurnRunner = async function* (input) {
  yield { text: 'Login flow refactored — token handling now lives in one place.' };
  yield { tool: { name: 'read_file', state: 'done', ms: 12 } };
  yield { tool: { name: 'apply_patch', state: 'done', ms: 48 } };
  yield { usage: { totalTokens: 12400 } };
};

test('render', async () => {
  process.env.AGENTFORGE_GLYPHS = 'unicode';
  process.env.COLUMNS = '110';
  const instance = render(React.createElement(ChatHome, {
    runner,
    commands: [],
    autoResume: false,
    provider: 'zai',
    model: 'glm-5.3',
    projectName: 'my-app',
  }));
  await delay(40);
  instance.stdin.write('refactor the login flow and run the tests');
  await delay(120);
  instance.stdin.write('\r');
  for (let i = 0; i < 30; i += 1) {
    await delay(50);
    if ((instance.lastFrame() ?? '').includes('The Forge speaks')) break;
  }
  console.log('====END FRAME====');
  instance.unmount();
  instance.unmount();
});
