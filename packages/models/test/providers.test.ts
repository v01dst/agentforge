import { describe, expect, it } from 'vitest';
import { MockModel, createModel } from '../src/index.js';

describe('model providers', () => {
  it('provides deterministic mock responses and streaming chunks', async () => {
    const model = new MockModel({ responses: ['hello world'] });
    const response = await model.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.content).toBe('hello world');
    const chunks: string[] = [];
    for await (const chunk of model.stream!({ messages: [{ role: 'user', content: 'hi' }] })) chunks.push(chunk.delta);
    expect(chunks.join('')).toContain('hello world');
  });

  it('selects adapters without binding callers to a provider class', () => {
    expect(createModel({ provider: 'mock' }).provider).toBe('mock');
    expect(createModel({ provider: 'openai', apiKey: 'test' }).provider).toBe('openai');
    expect(createModel({ provider: 'anthropic', apiKey: 'test' }).provider).toBe('anthropic');
    expect(createModel({ provider: 'google', apiKey: 'test' }).provider).toBe('google');
  });
});
