import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { ChatHome, SLASH_COMMANDS, type SlashCommand } from '../src/ui/shell/ChatHome.js';
import type { TurnRunner } from '../src/ui/turn.js';

const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const instantRunner: TurnRunner = async function* (input) {
  yield { text: `reply-to:${input}` };
  yield { usage: { totalTokens: 7 } };
};

const commands: readonly SlashCommand[] = [
  { name: 'models', description: 'List models' },
  { name: 'model', description: 'Select model', usage: '/model <name>' },
  { name: 'connect', description: 'Connect provider' },
  { name: 'config', description: 'Edit configuration' },
];

test('default SLASH_COMMANDS covers the required registry', () => {
  const names = SLASH_COMMANDS.map((command) => command.name);
  for (const expected of [
    'help', 'connect', 'providers', 'models', 'model', 'tools', 'skills',
    'agents', 'workflows', 'runs', 'inspect', 'test', 'doctor', 'config',
    'settings', 'clear', 'status', 'init', 'new', 'project', 'chat', 'exit',
  ]) {
    assert.ok(names.includes(expected), `missing /${expected}`);
  }
});

test('ChatHome renders status bar with provider and model', async () => {
  const instance = render(React.createElement(ChatHome, {
    runner: instantRunner,
    commands,
    provider: 'mock-provider',
    model: 'agentforge-local',
  }));
  await delay(30);
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /mock-provider · agentforge-local/);
  assert.match(frame, /mode:/);
  assert.match(frame, /\[Ctrl\+K\] palette \[\?\] help/);
  instance.unmount();
});

test("typing '/mo' filters suggestions to /models and /model", async () => {
  const instance = render(React.createElement(ChatHome, { runner: instantRunner, commands }));
  await delay(30);
  instance.stdin.write('/mo');
  await delay(80);
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /\/models/);
  assert.match(frame, /\/model /);
  assert.doesNotMatch(frame, /\/connect/);
  instance.unmount();
});

test('normal text + Enter sends a turn and shows user + assistant messages', async () => {
  const instance = render(React.createElement(ChatHome, { runner: instantRunner, commands }));
  await delay(30);
  instance.stdin.write('hello agent');
  await delay(40);
  instance.stdin.write('\r');
  await delay(150);
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /you › hello agent/);
  assert.match(frame, /reply-to:hello agent/);
  assert.match(frame, /tokens: 7/);
  instance.unmount();
});

test('Enter over a no-arg suggestion runs it; Esc dismisses menu keeping text', async () => {
  const seen: Array<[string, string[]]> = [];
  const onSlashCommand = (name: string, args: string[]) => { seen.push([name, args]); };
  const instance = render(React.createElement(ChatHome, {
    runner: instantRunner,
    commands,
    onSlashCommand,
  }));
  await delay(30);
  instance.stdin.write('/co'); // matches connect + config, both no-usage
  await delay(60);
  instance.stdin.write('\r'); // select first (connect)
  await delay(60);
  assert.deepEqual(seen, [['connect', []]]);
  instance.stdin.write('/conne');
  await delay(40);
  instance.stdin.write('\u001b'); // esc
  await delay(40);
  const frame = instance.lastFrame() ?? '';
  assert.doesNotMatch(frame, /List provider/); // menu closed
  instance.stdin.write('ct'); // finish the command with menu dismissed
  await delay(40);
  instance.stdin.write('\r');
  await delay(60);
  assert.deepEqual(seen[1], ['connect', []]);
  instance.unmount();
});
