import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, EventBus, MaxIterationsError } from '../src/index.js';
import type { ModelProvider } from '../src/types.js';

function model(responses: Array<{ content: string; toolCalls?: Array<{ id: string; name: string; arguments: unknown }> }>): ModelProvider {
  let index = 0;
  return {
    provider: 'test',
    model: 'test-1',
    async generate() {
      const response = responses[Math.min(index++, responses.length - 1)]!;
      return { id: `response-${index}`, content: response.content, toolCalls: response.toolCalls, finishReason: response.toolCalls?.length ? 'tool_calls' : 'stop', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } };
    },
  };
}

describe('Agent', () => {
  it('runs a model/tool loop and emits lifecycle events', async () => {
    const events = new EventBus();
    const seen: string[] = [];
    events.addSink({ emit: (event) => { seen.push(event.type); } });
    const add = { name: 'add', description: 'Add two numbers', inputSchema: z.object({ a: z.number(), b: z.number() }), execute: async (value: unknown) => { const { a, b } = z.object({ a: z.number(), b: z.number() }).parse(value); return a + b; } };
    const agent = new Agent({ name: 'calculator', model: model([{ content: '', toolCalls: [{ id: 'call-1', name: 'add', arguments: { a: 2, b: 3 } }] }, { content: 'five' }]), tools: [add], events });
    const result = await agent.run('Compute 2 + 3');
    expect(result.output).toBe('five');
    expect(result.toolCalls[0]?.output).toBe(5);
    expect(result.iterations).toBe(2);
    expect(result.usage.totalTokens).toBe(10);
    expect(seen).toEqual(expect.arrayContaining(['agent.started', 'model.requested', 'tool.started', 'tool.completed', 'agent.completed']));
  });

  it('stops runaway tool loops at the iteration limit', async () => {
    const agent = new Agent({ name: 'loop', model: model([{ content: '', toolCalls: [{ id: 'call', name: 'noop', arguments: {} }] }]), tools: [{ name: 'noop', description: 'noop', inputSchema: z.object({}), execute: async () => null }], maxIterations: 2 });
    await expect(agent.run('loop')).rejects.toBeInstanceOf(MaxIterationsError);
  });
});
