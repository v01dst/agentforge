import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILTIN_BENCHMARKS,
  getBenchmark,
  recordBenchmarkResult,
  readBenchmarkResults,
  runBenchmark,
  scoreResults,
} from '../src/benchmarks/benchmarks.js';
import type { TurnRunner } from '../src/ui/turn.js';

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'af-bench-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Scripted runner that simulates an agent solving each built-in case. */
const perfectRunner: TurnRunner = async function* (prompt) {
  if (prompt.startsWith('Create a file named result.txt')) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile('result.txt', 'benchmark-ok\n', 'utf8');
    yield { text: 'created result.txt' };
  } else if (prompt.startsWith('In note.txt')) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile('note.txt', 'status: FRESH\nversion: 1\n', 'utf8');
    yield { text: 'edited note.txt' };
  } else if (prompt.startsWith('Read benchmark-marker.txt')) {
    yield { text: 'contents: do-not-touch (untouched)' };
  } else {
    yield { text: `unhandled: ${prompt.slice(0, 30)}` };
  }
};

/** A runner that talks but never touches the workspace. */
const lazyRunner: TurnRunner = async function* (prompt) {
  yield { text: `I would do: ${prompt.slice(0, 20)}` };
};

test('built-in benchmark catalog is complete and has deterministic checkers', async () => {
  assert.deepEqual(BUILTIN_BENCHMARKS.map((entry) => entry.id), ['file-creation', 'file-edit', 'restraint']);
  assert.ok(getBenchmark('file-edit'));
  assert.equal(getBenchmark('nonexistent'), undefined);
});

test('a compliant scripted runner passes every built-in case', async () => {
  for (const benchmark of BUILTIN_BENCHMARKS) {
    const result = await runBenchmark(benchmark, { runner: perfectRunner, label: 'scripted' });
    assert.equal(result.passed, true, `${benchmark.id}: ${result.detail}`);
  }
});

test('a do-nothing runner fails the actionable cases but passes restraint', async () => {
  const creation = await runBenchmark(getBenchmark('file-creation')!, { runner: lazyRunner });
  assert.equal(creation.passed, false);
  assert.match(creation.detail, /not created/);
  const restraint = await runBenchmark(getBenchmark('restraint')!, { runner: lazyRunner });
  assert.equal(restraint.passed, true, 'not touching files is correct for the restraint case');
});

test('results persist to NDJSON and score by latest-per-case', async () => {
  await withTemp(async (root) => {
    const first = await runBenchmark(getBenchmark('file-creation')!, { runner: lazyRunner });
    await recordBenchmarkResult(first, root);
    const second = await runBenchmark(getBenchmark('file-creation')!, { runner: perfectRunner });
    await recordBenchmarkResult(second, root);
    const results = await readBenchmarkResults(root);
    assert.equal(results.length, 2);
    // The older failing run must not be overwritten — the log is append-only.
    assert.equal(results[0]!.passed, false);
    assert.equal(results[1]!.passed, true);
    const score = scoreResults(results);
    assert.deepEqual(score, { total: 1, passed: 1 }, 'latest result per case scores');
    const raw = await readFile(join(root, '.agentforge', 'benchmarks', 'results.ndjson'), 'utf8');
    assert.equal(raw.split('\n').filter(Boolean).length, 2);
  });
});
