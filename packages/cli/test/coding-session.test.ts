import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type ModelProvider, type ModelResponse } from '@agentforge-oss/core';
import {
  clearApprovals,
  requestToolApproval,
  resolveToolApproval,
  subscribeApprovals,
} from '../src/approvals.js';
import { setPermissionMode } from '../src/permissions.js';

test('approval bus: resolves decisions and notifies listeners', async () => {
  clearApprovals();
  const lengths: number[] = [];
  const unsubscribe = subscribeApprovals((pending) => lengths.push(pending.length));
  const promise = requestToolApproval({ tool: 'apply_patch', permissions: ['filesystem:write'], summary: 'patch a.ts' });
  assert.equal(lengths.at(-1), 1);
  let capturedId = '';
  const off = subscribeApprovals((pending) => {
    if (pending[0]) capturedId = pending[0].id;
  });
  off();
  resolveToolApproval(capturedId, { approved: true, sessionOnly: true });
  const decision = await promise;
  assert.deepEqual(decision, { approved: true, sessionOnly: true });
  unsubscribe();
  clearApprovals();
});

test('approval bus fails closed with no listeners', async () => {
  clearApprovals();
  const decision = await requestToolApproval({ tool: 'run_command', permissions: ['process:execute'], summary: 'ls' });
  assert.equal(decision.approved, false);
});

/** Deterministic provider that requests one tool call, then finishes. */
function scriptedProvider(script: Array<Pick<ModelResponse, 'toolCalls' | 'content'>>): ModelProvider {
  let turn = 0;
  return {
    provider: 'mock',
    model: 'scripted',
    async generate(): Promise<ModelResponse> {
      const step = script[Math.min(turn, script.length - 1)];
      turn += 1;
      return {
        id: `resp-${turn}`,
        content: step.content ?? '',
        finishReason: step.toolCalls?.length ? 'tool_calls' : 'stop',
        model: 'scripted',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        ...(step.toolCalls ? { toolCalls: step.toolCalls } : {}),
      } as ModelResponse;
    },
  };
}

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentforge-coding-'));
  await writeFile(join(dir, 'notes.txt'), 'hello forge\n');
  return dir;
}

async function collect(runner: ReturnType<typeof import('../src/coding-session.js').buildAgentRunner>, input: string): Promise<{ text: string; tools: Array<{ name: string; state: string }> }> {
  const controller = new AbortController();
  let text = '';
  const tools: Array<{ name: string; state: string }> = [];
  for await (const delta of runner(input, controller.signal, { skills: [] })) {
    if (delta.text) text += delta.text;
    if (delta.tool) tools.push({ name: delta.tool.name, state: delta.tool.state });
  }
  return { text, tools };
}

test('agent runner executes repository tools end to end (injected model)', async () => {
  const root = await makeWorkspace();
  try {
    const { buildAgentRunner } = await import('../src/coding-session.js');
    const runner = buildAgentRunner({
      root,
      modelInstance: scriptedProvider([
        { toolCalls: [{ id: 'call-1', name: 'read_file', arguments: { path: 'notes.txt' } }] },
        { content: 'The file says hello.' },
      ]),
    });
    const { text, tools } = await collect(runner, 'read notes.txt please');
    assert.match(text, /hello/i);
    assert.equal(tools.filter((entry) => entry.state === 'done').length >= 1, true);
    assert.ok(tools.some((entry) => entry.name === 'read_file'));
  } finally {
    await rm(root, { recursive: true, force: true });
    clearApprovals();
  }
});

test('read-only mode denies apply_patch without prompting', async () => {
  const root = await makeWorkspace();
  setPermissionMode('read-only');
  try {
    const agent = new Agent({
      name: 'policy-probe',
      model: scriptedProvider([{ content: 'cannot patch in read-only' }]),
      tools: [],
    });
    void agent;
    const { buildAgentRunner } = await import('../src/coding-session.js');
    const runner = buildAgentRunner({ root });
    // Drive apply_patch directly through the policy by asking for it;
    // exercise the wrapped tool via the coding session's exported test hook.
    const { createCodingTools } = await import('../src/coding-tools.js');
    const patcher = createCodingTools({ root }).find((tool) => tool.name === 'apply_patch');
    assert.ok(patcher, 'apply_patch tool exists');
    setPermissionMode('read-only');
    try {
      const wrappedFresh = createCodingTools({ root }).find((tool) => tool.name === 'apply_patch') as never;
      await assert.rejects(
        () => (wrappedFresh as { execute: (i: unknown, c: unknown) => Promise<unknown> }).execute({ patch: `--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-a\n+b`, dryRun: false }, { runId: 't', signal: new AbortController().signal }),
        /not permitted in read-only mode/,
      );
    } finally {
      setPermissionMode('ask');
    }
  } finally {
    setPermissionMode('ask');
    await rm(root, { recursive: true, force: true });
  }
});

test('ask mode prompts through the approval bus; deny blocks execution', async () => {
  const root = await makeWorkspace();
  setPermissionMode('ask');
  const seenIds: string[] = [];
  const off = subscribeApprovals((pending) => {
    const id = pending.at(-1)?.id;
    if (id) seenIds.push(id);
  });
  try {
    const { createCodingTools } = await import('../src/coding-tools.js');
    const { applyWorkspacePolicy } = await import('../src/permissions.js');
    const makeWrapped = () => createCodingTools({ root, requestApproval: (request) => requestToolApproval(request) }).find((tool) => tool.name === 'apply_patch') as unknown as { execute: (i: unknown, c: unknown) => Promise<unknown> };

    const denyPatch = { patch: `--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-hello forge\n+world`, dryRun: false };
    const denyRun = makeWrapped().execute(denyPatch, { runId: 't', signal: new AbortController().signal });
    await new Promise((r) => setTimeout(r, 20));
    resolveToolApproval(seenIds.at(-1) as string, { approved: false });
    await assert.rejects(() => denyRun, /User denied/);

    const allowPatch = { patch: `--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-hello forge\n+hello approved`, dryRun: false };
    const allowRun = makeWrapped().execute(allowPatch, { runId: 't2', signal: new AbortController().signal });
    await new Promise((r) => setTimeout(r, 20));
    resolveToolApproval(seenIds.at(-1) as string, { approved: true });
    const result = await allowRun;
    assert.ok(result);
    const after = await readFile(join(root, 'notes.txt'), 'utf8');
    assert.match(after, /hello approved/);
  } finally {
    off();
    setPermissionMode('ask');
    await rm(root, { recursive: true, force: true });
    clearApprovals();
  }
});
