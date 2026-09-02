import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { ChatHome, SLASH_COMMANDS, type SlashCommand } from '../src/ui/shell/ChatHome.js';
import { Frame } from '../src/ui/shell/Frame.js';
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
    autoResume: false,
  }));
  await delay(30);
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /mock-provider/);
  assert.match(frame, /agentforge-local/);
  assert.match(frame, /ctrl\+c cancel/);
  instance.unmount();
});

test("typing '/mo' filters suggestions to /models and /model", async () => {
  const instance = render(React.createElement(ChatHome, { runner: instantRunner, commands, initialInput: '/mo', autoResume: false }));
  await delay(80);
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /\/models/);
  assert.match(frame, /\/model /);
  assert.doesNotMatch(frame, /\/connect/);
  instance.unmount();
});

test('normal text + Enter sends a turn and shows user + assistant messages', async () => {
  const instance = render(React.createElement(ChatHome, { runner: instantRunner, commands, autoResume: false }));
  await delay(30);
  instance.stdin.write('hello agent');
  await delay(40);
  instance.stdin.write('\r');
  let frame = '';
  for (let i = 0; i < 40; i += 1) {
    await delay(50);
    frame = instance.lastFrame() ?? '';
    if (frame.includes('The Forge speaks') && frame.includes('reply-to:hello agent')) break;
  }
  assert.match(frame, /hello agent/);            // the scroll, right-leaning
  assert.match(frame, /reply-to:hello agent/);   // the forge speaks
  assert.match(frame, /The Forge speaks/);
  instance.unmount();
});

test('Enter over a no-arg suggestion runs it; Esc dismisses menu keeping text', async () => {
  const seen: Array<[string, string[]]> = [];
  const onSlashCommand = (name: string, args: string[]) => { seen.push([name, args]); };
  const instance = render(React.createElement(ChatHome, {
    runner: instantRunner,
    commands,
    onSlashCommand,
    autoResume: false,
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

test('up-arrow recalls previous inputs; down-arrow returns toward the draft', async () => {
  const instance = render(React.createElement(ChatHome, { runner: instantRunner, commands, autoResume: false }));
  await delay(30);
  instance.stdin.write('first input');
  await delay(40);
  instance.stdin.write('\r');
  await delay(150);
  instance.stdin.write('second input');
  await delay(40);
  instance.stdin.write('\r');
  await delay(150);
  instance.stdin.write('\u001b[A'); // up arrow
  await delay(60);
  let frame = instance.lastFrame() ?? '';
  assert.match(frame, /second input/);
  instance.stdin.write('\u001b[A'); // up arrow again
  await delay(60);
  frame = instance.lastFrame() ?? '';
  assert.match(frame, /first input/);
  instance.stdin.write('\u001b[B'); // down arrow back
  await delay(60);
  frame = instance.lastFrame() ?? '';
  assert.match(frame, /second input/);
  instance.unmount();
});

test('Frame renders header brand, mode badge, version and footer hints', async () => {
  const instance = render(React.createElement(Frame, {
    mode: { kind: 'project', name: 'demo' },
    version: '1.2.3',
    provider: 'mock-provider',
    model: 'agentforge-local',
  }, React.createElement(Text, null, 'body-content')));
  await delay(30);
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /AgentForge/);
  assert.match(frame, /PROJECT: demo/);
  assert.match(frame, /v1\.2\.3/);
  assert.match(frame, /\[Enter\] send/);
  assert.match(frame, /\[Ctrl\+K\] palette/);
  assert.match(frame, /\[Ctrl\+C\]/);
  assert.match(frame, /mock-provider/);
  assert.match(frame, /agentforge-local/);
  assert.match(frame, /body-content/);
  instance.unmount();
});

test('tool-role messages render as dim tool-call lines with duration', async () => {
  const toolRunner: TurnRunner = async function* () {
    yield { tool: { name: 'web_search', ms: 1200 } };
    yield { text: 'searched' };
  };
  const instance = render(React.createElement(ChatHome, { runner: toolRunner, commands, autoResume: false }));
  await delay(30);
  instance.stdin.write('go');
  await delay(40);
  instance.stdin.write('\r');
  await delay(200);
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /web_search\s+1200ms/);
  assert.match(frame, /searched/);
  instance.unmount();
});
