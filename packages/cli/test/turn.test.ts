import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildTurnRunner, parseSlashCommand, prependSkills, resolveRunnable, resultText } from '../src/ui/turn.js';

test('parseSlashCommand lowercases name and splits args', () => {
  assert.deepEqual(parseSlashCommand('/Skills code-review extra'), { name: 'skills', args: ['code-review', 'extra'] });
  assert.equal(parseSlashCommand('hello'), undefined);
  assert.equal(parseSlashCommand('/'), undefined);
});

test('resultText unwraps output envelopes and objects', () => {
  assert.equal(resultText('plain'), 'plain');
  assert.equal(resultText({ output: { content: 'hi' } }), 'hi');
  assert.equal(resultText({ runId: 'r1', output: 'done' }), 'done');
  assert.match(resultText({ nested: true }), /nested/);
});

test('prependSkills injects selected skill bodies before input', () => {
  const output = prependSkills('do work', ['body-a', 'body-b']);
  assert.match(output, /\[skill active\]\nbody-a/);
  assert.match(output, /\ndo work$/);
  assert.equal(prependSkills('do work', []), 'do work');
});

test('buildTurnRunner streams deltas from an agent factory export', async () => {
  const module = {
    createAgent: async () => ({
      run: async () => ({ output: 'unused' }),
      // eslint-disable-next-line require-yield
      stream: async function* () {
        yield { delta: 'Hel' };
        yield { delta: 'lo', usage: { totalTokens: 7 } };
      },
    }),
  };
  const runner = buildTurnRunner(module);
  const controller = new AbortController();
  const deltas: Array<{ text?: string; usage?: { totalTokens?: number }; runId?: string }> = [];
  for await (const delta of runner('hi', controller.signal, { skills: [] })) deltas.push(delta);
  assert.deepEqual(deltas.map((delta) => delta.text).join(''), 'Hello');
  assert.equal(deltas.at(-1)?.usage?.totalTokens, 7);
});

test('buildTurnRunner falls back to one-shot run exports', async () => {
  const module = { run: async (input: string) => `echo:${input}` };
  const runner = buildTurnRunner(module);
  const chunks: string[] = [];
  for await (const delta of runner('ping', new AbortController().signal, { skills: [] })) if (delta.text) chunks.push(delta.text);
  assert.equal(chunks.join(''), 'echo:ping');
});

test('resolveRunnable rejects modules without a runnable export', () => {
  assert.throws(() => resolveRunnable({}), /must export/);
});
