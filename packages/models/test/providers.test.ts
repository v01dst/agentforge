import { describe, expect, it } from 'vitest';
import { MockModel, createConfiguredModel, createModel, isProviderReady, resolveApiKey } from '../src/index.js';

function fetchStub(responder: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string | URL, init: RequestInit = {}) => {
    const urlText = String(url);
    calls.push({ url: urlText, init });
    const outcome = responder(urlText, init);
    return new Response(JSON.stringify(outcome.body), { status: outcome.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch: fn, calls };
}

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

  it('rejects openai-compatible endpoints without a baseUrl', () => {
    expect(() => createModel({ provider: 'openai-compatible' })).toThrow(/requires a baseUrl/);
  });

  it('routes openai-compatible requests to the configured endpoint with an optional key', async () => {
    const stub = fetchStub(() => ({ body: { id: 'x1', choices: [{ message: { content: 'proxied' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } } }));
    const model = createConfiguredModel({
      name: 'myproxy',
      protocol: 'openai-compatible',
      baseUrl: 'https://proxy.example/v1',
      model: 'vendor/curious-7b',
      apiKeyEnv: 'MYPROXY_API_KEY',
      fetch: stub.fetch,
    }, { MYPROXY_API_KEY: 'secret-value' });
    const response = await model.generate({ messages: [{ role: 'user', content: 'ping' }] });
    expect(response.content).toBe('proxied');
    const call = stub.calls[0]!;
    expect(call.url).toBe('https://proxy.example/v1/chat/completions');
    expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer secret-value');
    expect(JSON.parse(String(call.init.body)).model).toBe('vendor/curious-7b');
  });

  it('honors the definition model id for builtin protocols too', async () => {
    const stub = fetchStub(() => ({ body: { id: 'x2', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} } }));
    const model = createConfiguredModel({ protocol: 'anthropic', baseUrl: 'https://relay.example', model: 'claive-3', apiKey: 'k', fetch: stub.fetch }, {});
    await model.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(JSON.parse(String(stub.calls[0]!.init.body)).model).toBe('claive-3');
  });

  it('sends anthropic-style credentials to anthropic base URLs', async () => {
    const stub = fetchStub(() => ({ body: { id: 'a1', content: [{ type: 'text', text: 'claude says hi' }], stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 5 } } }));
    const direct = createModel({ provider: 'anthropic', baseUrl: 'https://relay.example/api', model: 'claive-3', apiKey: 'relay-secret', fetch: stub.fetch });
    const response = await direct.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.content).toBe('claude says hi');
    const call = stub.calls[0]!;
    expect(call.url).toBe('https://relay.example/api/messages');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('relay-secret');
    expect(JSON.parse(String(call.init.body)).model).toBe('claive-3');
  });

  it('sends gemini keys as query parameters to custom base URLs', async () => {
    const stub = fetchStub(() => ({ body: { candidates: [{ content: { parts: [{ text: 'gemini reply' }] } }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 7 } } }));
    const direct = createModel({ provider: 'google', baseUrl: 'https://gem-relay.example/v1beta', model: 'flashy-2', apiKey: 'gkey', fetch: stub.fetch });
    const response = await direct.generate({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.content).toBe('gemini reply');
    expect(stub.calls[0]!.url).toContain('https://gem-relay.example/v1beta/models/flashy-2:generateContent?key=gkey');
  });

  it('reports readiness and resolves keys without leaking values', () => {
    const proxy = { name: 'p', protocol: 'openai-compatible', baseUrl: 'https://p.example/v1', apiKeyEnv: 'P_KEY' } as const;
    expect(isProviderReady(proxy, {})).toBe(false);
    expect(isProviderReady(proxy, { P_KEY: 'yes' })).toBe(true);
    expect(resolveApiKey(proxy, { P_KEY: 'yes' })).toBe('yes');
    const local = { protocol: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' } as const;
    expect(isProviderReady(local, {})).toBe(true);
    const builtin = { protocol: 'google' } as const;
    expect(isProviderReady(builtin, { GEMINI_API_KEY: 'g' })).toBe(true);
    expect(isProviderReady(builtin, {})).toBe(false);
  });
});
