import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolEvent } from '../src/ui/turn.js';
import { MAX_TOOL_EVENTS, reduceToolEvents } from '../src/ui/useTurn.js';

const running = (name: string, argsSummary?: string): ToolEvent => ({ name, argsSummary, state: 'running' });
const done = (name: string, ms?: number): ToolEvent => ({ name, state: 'done', ms });

test('running event is added', () => {
  const next = reduceToolEvents([], running('search', 'q=foo'));
  assert.equal(next.length, 1);
  assert.equal(next[0]?.name, 'search');
  assert.equal(next[0]?.state, 'running');
});

test('second running event with same name replaces the first', () => {
  const next = reduceToolEvents([running('read'), running('grep')], running('read'));
  assert.equal(next.length, 2);
  const reads = next.filter((event) => event.name === 'read');
  assert.equal(reads.length, 1);
});

test('done event removes running entry and appends done marker at end', () => {
  const existing = [running('a'), running('b'), done('c', 5)];
  const next = reduceToolEvents(existing, done('a', 42));
  assert.equal(next.length, 3);
  assert.equal(next.some((event) => event.name === 'a' && event.state === 'running'), false);
  const last = next[next.length - 1];
  assert.equal(last?.state, 'done');
  assert.equal(last?.name, 'a');
  assert.equal(last?.ms, 42);
});

test(`tool event list is capped at ${MAX_TOOL_EVENTS} entries`, () => {
  let events: ToolEvent[] = [];
  for (let index = 0; index < 20; index += 1) {
    events = reduceToolEvents(events, running(`tool-${index}`));
    assert.ok(events.length <= MAX_TOOL_EVENTS);
  }
  assert.equal(events.length, MAX_TOOL_EVENTS);
  // Oldest dropped: newest name retained.
  assert.equal(events[events.length - 1]?.name, 'tool-19');
});
