import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compactIndex,
  ObservabilitySink,
  pruneObservability,
  readRunEvents,
  readRunIndex,
  runLogPath,
  summarizeRunEvents,
} from '../src/observability/sink.js';
import type { AgentEvent } from '@agentforge-oss/core';

function makeEvent(runId: string, type: AgentEvent['type'], offsetMs: number, data: Record<string, unknown> = {}): AgentEvent {
  return { type, runId, timestamp: new Date(Date.parse('2026-08-31T10:00:00Z') + offsetMs).toISOString(), data };
}

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'af-obs-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('sink writes NDJSON per-run logs plus a running index line', async () => {
  await withTemp(async (root) => {
    const sink = new ObservabilitySink(root);
    await sink.emit(makeEvent('run-1', 'agent.started', 0));
    await sink.emit(makeEvent('run-1', 'tool.started', 20, { tool: 'read_file' }));
    const raw = await readFile(runLogPath('run-1', root), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]!).type, 'agent.started');
    const index = await readRunIndex(root);
    assert.equal(index.length, 1);
    assert.equal(index[0]!.status, 'running');
    assert.equal(index[0]!.counts['tool.started'], 1);
  });
});

test('completed and failed runs update their index status', async () => {
  await withTemp(async (root) => {
    const sink = new ObservabilitySink(root);
    await sink.emit(makeEvent('run-a', 'agent.started', 0));
    await sink.emit(makeEvent('run-a', 'agent.completed', 100));
    await sink.emit(makeEvent('run-b', 'agent.started', 0));
    await sink.emit(makeEvent('run-b', 'agent.failed', 50, { error: 'boom' }));
    const index = await readRunIndex(root);
    assert.equal(index.length, 2);
    const statuses = new Map(index.map((entry) => [entry.runId, entry.status]));
    assert.equal(statuses.get('run-a'), 'completed');
    assert.equal(statuses.get('run-b'), 'failed');
  });
});

test('readRunEvents tolerates corrupt lines and reports missing runs', async () => {
  await withTemp(async (root) => {
    const sink = new ObservabilitySink(root);
    await sink.emit(makeEvent('run-1', 'agent.started', 0));
    // Simulate a torn write.
    const { appendFile } = await import('node:fs/promises');
    await appendFile(runLogPath('run-1', root), '{"type":"tool.sta\n', 'utf8');
    const events = await readRunEvents('run-1', root);
    assert.equal(events!.length, 1);
    assert.equal(await readRunEvents('never-happened', root), undefined);
  });
});

test('compactIndex keeps the latest entry per run', () => {
  const compacted = compactIndex([
    JSON.stringify({ runId: 'r1', startedAt: 'a', status: 'running', counts: {} }),
    JSON.stringify({ runId: 'r1', startedAt: 'a', status: 'completed', counts: {} }),
    JSON.stringify({ runId: 'r2', startedAt: 'b', status: 'running', counts: {} }),
    'garbage line',
  ].join('\n'));
  assert.equal(compacted.length, 2);
  assert.equal(compacted.find((entry) => entry.runId === 'r1')!.status, 'completed');
});

test('summarizeRunEvents renders status, counts, duration, and last failure', () => {
  const summary = summarizeRunEvents([
    makeEvent('r1', 'agent.started', 0),
    makeEvent('r1', 'tool.failed', 500, { tool: 'run_command', error: 'exit 1' }),
    makeEvent('r1', 'agent.completed', 1500),
  ]);
  assert.match(summary, /run r1 — completed · 3 events · 1\.5s/);
  assert.match(summary, /tool\.failed: 1/);
  assert.match(summary, /exit 1/);
});

test('pruneObservability removes stale run logs only', async () => {
  await withTemp(async (root) => {
    const sink = new ObservabilitySink(root);
    await sink.emit(makeEvent('old-run', 'agent.started', 0));
    await sink.emit(makeEvent('fresh-run', 'agent.started', 0));
    assert.ok(await readRunEvents('fresh-run', root), 'fresh run log exists before pruning');
    const { utimes } = await import('node:fs/promises');
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await utimes(runLogPath('old-run', root), old, old);
    const removed = await pruneObservability(14, root);
    assert.deepEqual(removed, ['old-run']);
    assert.equal(await readRunEvents('old-run', root), undefined, 'stale log removed');
    assert.equal((await readRunEvents('fresh-run', root))!.length, 1);
  });
});
