import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDigest, createReflectionRuntime } from '../src/reflection/review.js';
import { buildAgentRunner } from '../src/coding-session.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until the predicate holds or the deadline passes (background review is async). */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'af-reflect-'));
  try {
    await fn(root);
  } finally {
    // The background reviewer may still be finishing a write (memory/skill
    // staging) after the assertions pass; retry cleanup so the race cannot
    // fail the test at teardown.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { await rm(root, { recursive: true, force: true }); break; }
      catch { await sleep(50); }
    }
  }
}

test('buildDigest keeps recent inputs and caps length', () => {
  const digest = buildDigest(['first question', 'second question'], 'final answer');
  assert.match(digest, /User: first question/);
  assert.match(digest, /User: second question/);
  assert.match(digest, /Assistant \(latest\): final answer/);
  const tiny = buildDigest(['x'.repeat(50)], 'y'.repeat(50), 40);
  assert.ok(tiny.length <= 45, 'digest respects the char cap');
  assert.match(tiny, /^…/);
});

test('reflection disabled by default writes nothing', async () => {
  await withTemp(async (root) => {
    const model = {
      generate: async () => ({ id: 'x', content: 'answer', finishReason: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }),
    };
    const runner = buildAgentRunner({ root, modelInstance: model });
    for await (const delta of runner('remember this')) void delta;
    await sleep(30);
    await assert.rejects(() => readFile(join(root, '.agentforge', 'memories', 'MEMORY.md'), 'utf8'));
  });
});

test('enabled reflection reviews in the background and writes memory through gated tools', async () => {
  await withTemp(async (root) => {
    let reviewModelCalls = 0;
    const sessionModel = {
      generate: async () => ({ id: 'x', content: 'answer', finishReason: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }),
    };
    const reviewModel = {
      generate: async (request: { messages: Array<{ role: string; content: string }> }) => {
        reviewModelCalls += 1;
        const prompt = request.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
        if (prompt.includes('save this lesson')) {
          return {
            id: 'r', content: '', finishReason: 'tool_calls' as const,
            toolCalls: [{ id: 't1', name: 'memory', arguments: { action: 'add', target: 'memory', content: 'User ships fixes with pnpm test first' } }],
          };
        }
        return { id: 'r', content: 'nothing to save', finishReason: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      },
    };
    const runtime = createReflectionRuntime({
      enabled: true, root, modelInstance: reviewModel,
    });
    // Simulate the loop seam directly: record input, then stop the turn.
    for (const hook of runtime.interceptors.preStep ?? []) await hook({ input: 'remember this lesson: save this lesson', runId: 'r1' });
    for (const hook of runtime.interceptors.turnStopping ?? []) await hook({ output: 'answer', iterations: 1 });
    const written = await waitFor(async () => {
      try { await readFile(join(root, '.agentforge', 'memories', 'MEMORY.md'), 'utf8'); return true; } catch { return false; }
    });
    assert.ok(written, 'reviewer wrote memory in the background');
    assert.ok(reviewModelCalls >= 1, 'reviewer ran');
    const raw = await readFile(join(root, '.agentforge', 'memories', 'MEMORY.md'), 'utf8');
    assert.match(raw, /pnpm test first/);
    void sessionModel;
  });
});

test('reviewer errors never break the turn (fire-and-forget)', async () => {
  await withTemp(async (root) => {
    const runtime = createReflectionRuntime({
      enabled: true, root,
      modelInstance: { generate: async () => { throw new Error('reviewer down'); } },
    });
    for (const hook of runtime.interceptors.preStep ?? []) await hook({ input: 'hi', runId: 'r' });
    const notice = await runtime.reviewNow('output');
    assert.match(notice, /reflection failed/);
  });
});
