import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  SESSION_MODES,
  SESSION_MODE_DEFINITIONS,
  currentSessionMode,
  enterSessionMode,
  isSessionMode,
} from '../src/modes/session-modes.js';
import { currentPermissionMode, setPermissionMode, applyWorkspacePolicy } from '../src/permissions.js';
import { sessionModeInstructions } from '../src/coding-tools.js';
import type { SessionMode } from '../src/modes/session-modes.js';

test('session modes: definitions, validation, defaults', () => {
  assert.deepEqual(SESSION_MODES, ['chat', 'build', 'indie', 'automode']);
  assert.equal(isSessionMode('indie'), true);
  assert.equal(isSessionMode('chaos'), false);
  assert.equal(SESSION_MODE_DEFINITIONS.build.defaultPosture, 'workspace-write');
  assert.equal(SESSION_MODE_DEFINITIONS.chat.defaultPosture, 'ask');
  assert.match(SESSION_MODE_DEFINITIONS.automode.instructions, /automode/);
});

test('enterSessionMode applies the mode default posture and records the mode', () => {
  const previousMode = currentSessionMode();
  const previousPosture = currentPermissionMode();
  try {
    const chat = enterSessionMode('chat');
    assert.equal(chat.mode, 'chat');
    assert.equal(chat.postureApplied, 'ask');
    assert.equal(currentSessionMode(), 'chat');
    assert.equal(currentPermissionMode(), 'ask');
    const indie = enterSessionMode('indie');
    assert.equal(indie.postureApplied, 'workspace-write');
    assert.equal(currentSessionMode(), 'indie');
  } finally {
    enterSessionMode(previousMode === 'build' ? 'build' : previousMode as SessionMode);
    setPermissionMode(previousPosture);
  }
});

test('enterSessionMode returns an instruction fragment for injection', () => {
  const result = enterSessionMode('indie');
  assert.equal(result.instructions, sessionModeInstructions('indie'));
  assert.ok(result.instructions.length > 10);
  assert.equal(sessionModeInstructions(undefined), undefined);
});

function fakeTool(name: string, permissions: string[], calls: string[]) {
  return {
    name,
    description: 'test',
    inputSchema: { parse(value: unknown) { return (value ?? {}) as Record<string, unknown>; } },
    permissions,
    async execute() { calls.push(name); return { ok: true as const }; },
  };
}

test('LIVE POSTURE REGRESSION: posture switches take effect on already-wrapped tools', async () => {
  const calls: string[] = [];
  const tool = applyWorkspacePolicy(fakeTool('apply_patch', ['filesystem:write'], calls), {
    root: '/tmp/af-modes-test',
    mode: 'ask',
    // Simulates the CLI's live posture source.
    getMode: currentPermissionMode,
  });
  setPermissionMode('ask');
  await assert.rejects(() => tool.execute({ path: 'a.txt' }, { runId: 'r', signal: new AbortController().signal }), /requires approval|no approval prompt/);
  setPermissionMode('read-only');
  await assert.rejects(() => tool.execute({ path: 'a.txt' }, { runId: 'r', signal: new AbortController().signal }), /read-only mode/);
  // Now switch to workspace-write without rebuilding: same wrapped tool, auto-allowed.
  setPermissionMode('workspace-write');
  const result = await tool.execute({ path: 'a.txt' }, { runId: 'r', signal: new AbortController().signal }) as { ok: boolean };
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  setPermissionMode('ask');
});
