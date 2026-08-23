import { describe, expect, it } from 'vitest';
import { AgentRegistry, createAgent } from '../src/index.js';

describe('AgentRegistry', () => {
  it('registers and resolves named agents', () => {
    const agent = createAgent({ name: 'writer', model: { provider: 'test', async generate() { return { id: '1', content: 'ok', finishReason: 'stop' }; } } });
    const registry = new AgentRegistry().register(agent);
    expect(registry.get('writer')).toBe(agent);
    expect(registry.list()).toHaveLength(1);
  });
});
