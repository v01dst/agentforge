import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent } from '../src/index.js';
import { firstDenial, foldSerial, foldWaterfall } from '../src/interceptors.js';
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

const echoTool = {
  name: 'echo',
  description: 'Echo the input',
  permissions: [] as string[],
  inputSchema: z.object({ v: z.unknown().optional() }),
  execute: async (input: unknown) => ({ echoed: input }),
};

describe('interceptor seam', () => {
  it('foldWaterfall applies listeners in order, void passes through', async () => {
    const seen: string[] = [];
    const result = await foldWaterfall([
      async (value: string) => { seen.push(`a:${value}`); return `${value}+a`; },
      async (value: string) => { seen.push(`b:${value}`); },
      async (value: string) => { seen.push(`c:${value}`); return `${value}+c`; },
    ], 'x');
    expect(result).toBe('x+a+c');
    expect(seen).toEqual(['a:x', 'b:x+a', 'c:x+a']);
  });

  it('firstDenial returns the first reason string', async () => {
    const denial = await firstDenial([
      async () => undefined,
      async () => 'not allowed',
      async () => 'second',
    ], { id: '1', name: 't', arguments: {} });
    expect(denial).toBe('not allowed');
    expect(await firstDenial([async () => undefined], { id: '1', name: 't', arguments: {} })).toBeUndefined();
  });

  it('foldSerial rewrites output serially', async () => {
    const output = await foldSerial([
      async ({ output }) => output.toUpperCase(),
      async ({ output }) => `${output}!`,
    ], { output: 'hi', iterations: 1 });
    expect(output).toBe('HI!');
  });

  it('agent preStep rewrites the user input the model sees', async () => {
    let received = '';
    const backing = model([{ content: 'ok' }]);
    const original = backing.generate.bind(backing);
    (backing as { generate: typeof backing.generate }).generate = async (request) => {
      received = request.messages.at(-1)?.content ?? '';
      return original(request);
    };
    const agent = new Agent({
      name: 't', model: backing,
      interceptors: { preStep: [async ({ input }) => `${input} [annotated]`] },
    });
    await agent.run('do the thing');
    expect(received).toBe('do the thing [annotated]');
  });

  it('agent preTool denial short-circuits execution with a typed error', async () => {
    const agent = new Agent({
      name: 't',
      model: model([{ content: '', toolCalls: [{ id: 'c1', name: 'echo', arguments: { v: 1 } }] }, { content: 'done' }]),
      tools: [echoTool],
      interceptors: { preTool: [async (call) => (call.name === 'echo' ? 'blocked by policy' : undefined)] },
    });
    const result = await agent.run('go');
    expect(result.toolCalls[0]?.error?.message).toContain('denied by interceptor: blocked by policy');
  });

  it('agent postTool observes successful executions', async () => {
    const observed: string[] = [];
    const agent = new Agent({
      name: 't',
      model: model([{ content: '', toolCalls: [{ id: 'c1', name: 'echo', arguments: { v: 7 } }] }, { content: 'done' }]),
      tools: [echoTool],
      interceptors: { postTool: [async (execution) => { observed.push(`${execution.name}:${execution.attempts}`); }] },
    });
    await agent.run('go');
    expect(observed).toEqual(['echo:1']);
  });

  it('agent turnStopping rewrites the final output', async () => {
    const agent = new Agent({
      name: 't', model: model([{ content: 'raw output' }]),
      interceptors: { turnStopping: [async ({ output }) => `[reviewed] ${output}`] },
    });
    const result = await agent.run('go');
    expect(result.output).toBe('[reviewed] raw output');
  });
});
