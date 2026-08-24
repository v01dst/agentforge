import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  buildModelReport,
  createSessionFromModule,
  drainStream,
  formatTurnFooter,
  isCancelLike,
  transcriptSession,
} from '../src/session.js';
import type { StreamChunk } from '../src/types.js';

test('transcriptSession replays prior exchanges to one-shot runnables', async () => {
  const prompts: string[] = [];
  const session = transcriptSession(async (input: string) => {
    prompts.push(input);
    return { output: `echo:${input.length}`, runId: 'run_x', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 }, durationMs: 12 };
  });
  await session.send('first');
  const second = await session.send('second');
  assert.match(prompts[0], /User: first\nAssistant:/);
  assert.match(prompts[1], /User: first/);
  assert.match(prompts[1], /Assistant: echo:\d+/);
  assert.match(prompts[1], /User: second/);
  assert.equal(second.runId, 'run_x');
  assert.equal(second.usage?.totalTokens, 7);
  assert.equal(second.durationMs, 12);
});

test('createSessionFromModule prefers createSession exports', async () => {
  const inputs: string[] = [];
  const module = {
    run: async () => ({ output: 'one-shot' }),
    createSession: () => ({
      send: async (input: string) => {
        inputs.push(input);
        return { text: `session:${input}` };
      },
    }),
  };
  const session = await createSessionFromModule(module);
  const turn = await session.send('hi');
  assert.deepEqual(inputs, ['hi']);
  assert.equal(turn.text, 'session:hi');
});

test('createSessionFromModule rejects sessions without send()', async () => {
  await assert.rejects(
    () => createSessionFromModule({ createSession: () => ({}) }),
    /send\(input, options\)/,
  );
});

test('drainStream forwards deltas and captures metadata', async () => {
  async function* stream(): AsyncIterable<string | StreamChunk> {
    yield 'he';
    yield 'llo';
    yield { delta: '!', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, meta: { provider: 'mock' } };
    yield { delta: '', done: true };
    yield 'unreachable';
  }
  const seen: string[] = [];
  const result = await drainStream(stream(), (delta) => seen.push(delta));
  assert.equal(result.text, 'hello!');
  assert.deepEqual(seen, ['he', 'llo', '!']);
  assert.equal(result.usage?.totalTokens, 5);
  assert.equal(result.meta?.provider, 'mock');
  assert.equal(result.cancelled, false);
});

test('drainStream reports cancellation instead of throwing on abort errors', async () => {
  async function* stream(): AsyncIterable<string | StreamChunk> {
    yield 'partial';
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
  }
  const result = await drainStream(stream(), () => {});
  assert.equal(result.text, 'partial');
  assert.equal(result.cancelled, true);
});

test('isCancelLike recognizes abort-style errors only', () => {
  const aborted = new Error('aborted');
  aborted.name = 'AbortError';
  assert.equal(isCancelLike(aborted), true);
  assert.equal(isCancelLike(new Error('boom')), false);
});

test('formatTurnFooter composes available metadata and omits empties', () => {
  const full = formatTurnFooter({
    runId: 'run_1',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    durationMs: 123.6,
    meta: { provider: 'openai', model: 'gpt-4o-mini' },
  });
  assert.match(full ?? '', /\[run run_1 · openai\/gpt-4o-mini · 124ms · tokens in 10 out 5\]/);
  assert.equal(formatTurnFooter({}), undefined);
  assert.equal(formatTurnFooter({ text: undefined, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, durationMs: 0 }), '[0ms]');
});

test('buildModelReport flags credential readiness and appends config entries', () => {
  const rows = buildModelReport(
    [{ name: 'custom-provider-module', description: 'Local module' }, 'openai'],
    { OPENAI_API_KEY: 'set' },
  );
  const byName = new Map(rows.map((row) => [row.provider, row]));
  assert.equal(byName.get('openai')?.ready, true);
  assert.equal(byName.get('anthropic')?.ready, false);
  assert.equal(byName.get('google')?.ready, false);
  assert.equal(byName.get('mock')?.ready, true);
  const custom = byName.get('custom-provider-module');
  assert.equal(custom?.source, 'config');
  assert.equal(custom?.description, 'Local module');
  assert.equal(rows.filter((row) => row.provider === 'openai').length, 1, 'config entries dedupe against builtins');
});
