import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { ChatHome } from '../src/ui/shell/ChatHome.js';
import type { TurnRunner } from '../src/ui/turn.js';

const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const instantRunner: TurnRunner = async function* (input) {
  yield { text: `reply-to:${input}` };
};

test('ChatHome autosaves the transcript after a turn settles', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agentforge-autosave-'));
  const previousCwd = process.cwd();
  process.chdir(project);
  try {
    const instance = render(React.createElement(ChatHome, {
      runner: instantRunner,
      commands: [],
      initialMessages: [
        { role: 'user', text: 'hello durable world' },
        { role: 'assistant', text: 'reply-to:ping' },
      ],
      autoResume: false,
    }));
    // A settled assistant reply in the seed transcript triggers autosave.
    for (let i = 0; i < 30; i += 1) {
      await delay(50);
      const dir = join(project, '.agentforge', 'sessions');
      try { if ((await readdir(dir)).length === 1) break; } catch { /* not yet */ }
    }
    instance.unmount();
    await delay(150);

    const dir = join(project, '.agentforge', 'sessions');
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    const stored = JSON.parse(await readFile(join(dir, files[0] as string), 'utf8')) as { messages: Array<{ role: string; text: string }> };
    assert.ok(stored.messages.some((m) => m.text === 'hello durable world'));
    assert.ok(stored.messages.some((m) => m.text.includes('reply-to:ping')));
    assert.ok(stored.messages.some((m) => m.text === 'hello durable world'));
  } finally {
    process.chdir(previousCwd);
    await rm(project, { recursive: true, force: true });
  }
});
