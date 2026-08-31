import { describe, expect, it } from 'vitest';
import { ModelHttpError, createConfiguredModel, createModel, type OpenAIModel } from '../src/index.js';
import type { ModelChunk } from '@agentforge-oss/core';

/** Builds an SSE Response from raw event chunks (each already `data: ...` formatted or plain JSON). */
function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`${event}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function fetchSseStub(responder: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string | URL, init: RequestInit = {}) => {
    const urlText = String(url);
    calls.push({ url: urlText, init });
    return responder(urlText, init);
  }) as typeof globalThis.fetch;
  return { fetch: fn, calls };
}

async function collect(stream: AsyncIterable<ModelChunk>): Promise<{ text: string; toolCalls: ModelChunk['toolCall'][]; usage?: ModelChunk['usage']; done: boolean }> {
  let text = '';
  const toolCalls: ModelChunk['toolCall'][] = [];
  let usage: ModelChunk['usage'];
  let done = false;
  for await (const chunk of stream) {
    if (chunk.delta) text += chunk.delta;
    if (chunk.toolCall) toolCalls.push(chunk.toolCall);
    if (chunk.usage) usage = chunk.usage;
    if (chunk.done) done = true;
  }
  return { text, toolCalls, usage, done };
}

const requestOf = { messages: [{ role: 'user' as const, content: 'hi' }] };

describe('streaming conformance', () => {
  it('openai streams text deltas, assembles fragment tool calls, and reports usage', async () => {
    const stub = fetchSseStub(() => sseResponse([
      'data: {"id":"o1","choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"id":"o1","choices":[{"delta":{"content":"lo!"}}]}',
      'data: {"id":"o1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"get_weather","arguments":"{\\"ci"}}]}}]}',
      'data: {"id":"o1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ty\\":\\"Paris\\"}"}}]}}]}',
      'data: {"id":"o1","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":7}}',
      'data: [DONE]',
    ]));
    const model = createModel({ provider: 'openai', apiKey: 'k', fetch: stub.fetch }) as OpenAIModel;
    const result = await collect(model.stream(requestOf));
    expect(result.text).toBe('Hello!');
    expect(result.done).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 7, totalTokens: 12 });
    expect(result.toolCalls).toEqual([{ id: 'c1', name: 'get_weather', arguments: { city: 'Paris' } }]);
    // The streaming request asked for SSE with stream: true.
    expect(JSON.parse(String(stub.calls[0]!.init.body)).stream).toBe(true);
  });

  it('openai text-only stream matches the non-streaming content', async () => {
    const jsonStub = fetchSseStub(() => new Response(JSON.stringify({ id: 'o2', choices: [{ message: { content: 'plain answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const sseStub = fetchSseStub(() => sseResponse([
      'data: {"id":"o2","choices":[{"delta":{"content":"plain "}}]}',
      'data: {"id":"o2","choices":[{"delta":{"content":"answer"}}]}',
      'data: {"id":"o2","choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ]));
    const plain = createModel({ provider: 'openai', apiKey: 'k', fetch: jsonStub.fetch });
    const streamed = createModel({ provider: 'openai', apiKey: 'k', fetch: sseStub.fetch }) as OpenAIModel;
    const nonStream = await plain.generate(requestOf);
    const stream = await collect(streamed.stream(requestOf));
    expect(stream.text).toBe(nonStream.content);
  });

  it('anthropic streams text deltas and assembles input_json_delta tool calls', async () => {
    const stub = fetchSseStub(() => sseResponse([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"a1","usage":{"input_tokens":4}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","id":"t1","name":"get_weather"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"\\"Rome\\"}"}}',
      'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"text"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"done"}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ]));
    const model = createModel({ provider: 'anthropic', apiKey: 'k', fetch: stub.fetch });
    const result = await collect(model.stream!(requestOf));
    expect(result.text).toBe('done');
    expect(result.done).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 9, totalTokens: 13 });
    expect(result.toolCalls).toEqual([{ id: 't1', name: 'get_weather', arguments: { city: 'Rome' } }]);
  });

  it('gemini streams sse parts and forwards usage metadata', async () => {
    const stub = fetchSseStub((url) => {
      expect(url).toContain(':streamGenerateContent?alt=sse&key=gkey');
      return sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"gem"}]}}]}',
        'data: {"candidates":[{"content":{"parts":[{"text":"ini"}]}}]}',
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"Oslo"}}}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":6}}',
      ]);
    });
    const model = createModel({ provider: 'google', apiKey: 'gkey', fetch: stub.fetch });
    const result = await collect(model.stream!(requestOf));
    expect(result.text).toBe('gemini');
    expect(result.done).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 6, totalTokens: 9 });
    expect(result.toolCalls).toEqual([{ id: expect.any(String), name: 'get_weather', arguments: { city: 'Oslo' } }]);
  });

  it('openai-compatible endpoints stream through the openai adapter', async () => {
    const stub = fetchSseStub((url) => {
      expect(url).toBe('https://proxy.example/v1/chat/completions');
      return sseResponse([
        'data: {"id":"p1","choices":[{"delta":{"content":"via proxy"}}]}',
        'data: [DONE]',
      ]);
    });
    const model = createConfiguredModel({
      name: 'myproxy',
      protocol: 'openai-compatible',
      baseUrl: 'https://proxy.example/v1',
      model: 'vendor/curious-7b',
      apiKeyEnv: 'MYPROXY_API_KEY',
      fetch: stub.fetch,
    }, { MYPROXY_API_KEY: 'secret-value' });
    const result = await collect(model.stream!(requestOf));
    expect(result.text).toBe('via proxy');
    expect(result.done).toBe(true);
  });
});

describe('provider error normalization', () => {
  it('classifies 429 with Retry-After as retryable and converts the delay', async () => {
    const stub = fetchSseStub(() => new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429, headers: { 'retry-after': '2' } }));
    const model = createModel({ provider: 'openai', apiKey: 'k', fetch: stub.fetch });
    const error = await model.generate(requestOf).catch((caught) => caught);
    expect(error).toBeInstanceOf(ModelHttpError);
    expect((error as ModelHttpError).status).toBe(429);
    expect((error as ModelHttpError).retryable).toBe(true);
    expect((error as ModelHttpError).retryAfterMs).toBe(2000);
  });

  it('classifies auth failures as non-retryable', async () => {
    const stub = fetchSseStub(() => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }));
    const model = createModel({ provider: 'anthropic', apiKey: 'wrong', fetch: stub.fetch });
    const error = await model.generate(requestOf).catch((caught) => caught);
    expect(error).toBeInstanceOf(ModelHttpError);
    expect((error as ModelHttpError).status).toBe(401);
    expect((error as ModelHttpError).retryable).toBe(false);
  });

  it('classifies server errors as retryable', () => {
    const error = new ModelHttpError(503, 'overloaded');
    expect(error.retryable).toBe(true);
    expect(new ModelHttpError(404, 'no such model').retryable).toBe(false);
  });
});
