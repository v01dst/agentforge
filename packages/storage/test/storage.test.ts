import { describe, expect, it } from 'vitest';
import { InMemoryRunStore } from '../src/index.js';

describe('run storage', () => {
  it('persists and filters run records', async () => {
    const store = new InMemoryRunStore();
    await store.createRun({ id: 'run-1', status: 'completed', startedAt: '2026-01-01T00:00:00Z', output: 'ok' });
    await store.createRun({ id: 'run-2', status: 'failed', startedAt: '2026-01-02T00:00:00Z', error: 'bad' });
    expect((await store.getRun('run-1'))?.output).toBe('ok');
    expect(await store.listRuns({ status: 'failed' })).toHaveLength(1);
  });
});
