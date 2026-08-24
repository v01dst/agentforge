import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { ChatApp, type SkillInfo } from '../src/ui/ChatApp.js';
import type { TurnRunner } from '../src/ui/turn.js';

const instantRunner: TurnRunner = async function* (input) {
  yield { text: `reply-to:${input}` };
  yield { usage: { totalTokens: 12 } };
};

const skills: SkillInfo[] = [{ name: 'code-review', description: 'Review code carefully', body: 'Be careful.' }];

const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

test('ChatApp renders status bar and processes commands plus turns', async () => {
  const instance = render(React.createElement(ChatApp, {
    runner: instantRunner,
    provider: 'mock',
    model: 'agentforge-local',
    extensions: { plugins: ['./plugins/example.ts'], mcpServers: ['files'] },
    skills,
    initialCommands: ['/help', 'hello agent'],
  }));
  await delay(40);
  assert.match(instance.lastFrame() ?? '', /mock · agentforge-local/);
  assert.match(instance.lastFrame() ?? '', /plugins: 1 · mcp: 1/);
  await delay(150);
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /Commands:/);
  assert.match(frame, /reply-to:hello agent/);
  assert.match(frame, /tokens:/);
  instance.unmount();
});

test('ChatApp toggles a skill via /skills <name>', async () => {
  const instance = render(React.createElement(ChatApp, {
    runner: instantRunner,
    skills,
    initialCommands: ['/skills', '/skills code-review'],
  }));
  await delay(200);
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /skills: code-review/);
  instance.unmount();
});

test('typing appears in the input box via stdin', async () => {
  const instance = render(React.createElement(ChatApp, { runner: instantRunner }));
  await delay(30);
  instance.stdin.write('hi');
  await delay(80);
  assert.match(instance.lastFrame() ?? '', /❯ hi▏/);
  instance.unmount();
});
