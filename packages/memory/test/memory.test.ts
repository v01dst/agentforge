import { describe, expect, it } from 'vitest';
import { InMemoryMemoryProvider } from '../src/index.js';

describe('InMemoryMemoryProvider', () => {
  it('recalls relevant, non-expired memories by namespace', async () => {
    const memory = new InMemoryMemoryProvider();
    await memory.remember({ namespace: 'user-1', type: 'long-term', content: 'User likes TypeScript' });
    await memory.remember({ namespace: 'user-2', content: 'Different user' });
    const result = await memory.recall({ namespace: 'user-1', query: 'typescript' });
    expect(result).toHaveLength(1);
    expect(result[0]?.score).toBeGreaterThan(0);
  });
});
