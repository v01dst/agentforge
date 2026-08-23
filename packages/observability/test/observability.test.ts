import { describe, expect, it } from 'vitest';
import { MemoryEventStore, redactSecrets, redactEvent } from '../src/index.js';

describe('observability', () => {
  it('redacts common secrets recursively', () => {
    expect(redactSecrets({ apiKey: 'sk-123456789012', nested: 'Bearer abc' })).toEqual({ apiKey: '[REDACTED]', nested: 'Bearer [REDACTED]' });
  });

  it('stores and filters events by run', () => {
    const store = new MemoryEventStore();
    store.append({ type: 'agent.started', runId: 'run-a', timestamp: new Date().toISOString(), data: {} });
    store.append(redactEvent({ type: 'agent.completed', runId: 'run-b', timestamp: new Date().toISOString(), data: { token: 'secret' } }));
    expect(store.list('run-a')).toHaveLength(1);
    expect(store.list('run-b')[0]?.data.token).toBe('[REDACTED]');
  });
});
