import { describe, expect, it } from 'vitest';
import { listProviderModels, listProviderModelIds, sortRemoteModels } from '../src/model-discovery.js';
import { ModelHttpError } from '../src/providers.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('listProviderModels: openai-compatible', () => {
  it('reads { data: [{ id }] } and sorts ids', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const models = await listProviderModelIds({
      protocol: 'openai-compatible',
      baseUrl: 'https://api.z.ai/api/paas/v4/',
      apiKey: 'zk-test',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse(200, { data: [{ id: 'glm-5.3' }, { id: 'glm-5.3-flash' }, { id: 'glm-5.3' }] });
      },
    });
    expect(models).toEqual(['glm-5.3', 'glm-5.3-flash']);
    expect(calls[0]!.url).toBe('https://api.z.ai/api/paas/v4/models');
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer zk-test');
  });

  it('falls back to the `model` field when `id` is absent (some routers)', async () => {
    const models = await listProviderModels({
      protocol: 'openai-compatible',
      baseUrl: 'https://router.example/v1',
      fetch: async () => jsonResponse(200, { data: [{ model: 'weird-router-model' }] }),
    });
    expect(models.map((model) => model.id)).toEqual(['weird-router-model']);
  });

  it('carries ownedBy metadata when present', async () => {
    const models = await listProviderModels({
      protocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      fetch: async () => jsonResponse(200, { data: [{ id: 'gpt-5.6-sol', owned_by: 'openai' }] }),
    });
    expect(models[0]!.ownedBy).toBe('openai');
  });
});

describe('listProviderModels: anthropic', () => {
  it('targets /v1/models with x-api-key + version headers', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const models = await listProviderModels({
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse(200, { data: [{ id: 'claude-opus-5', display_name: 'Claude Opus 5' }, { id: 'claude-sonnet-5' }] });
      },
    });
    expect(models.map((model) => model.id)).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/models');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('adds /v1 when the base url omits it', async () => {
    const calls: string[] = [];
    await listProviderModels({
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      fetch: async (url) => { calls.push(String(url)); return jsonResponse(200, { data: [] }); },
    });
    expect(calls[0]).toBe('https://api.anthropic.com/v1/models');
  });
});

describe('listProviderModels: google', () => {
  it('strips the models/ prefix and passes the key as a query param', async () => {
    const calls: Array<{ url: string }> = [];
    const models = await listProviderModels({
      protocol: 'google',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'g-key',
      fetch: async (url) => {
        calls.push({ url: String(url) });
        return jsonResponse(200, { models: [{ name: 'models/gemini-2.0-flash', input_token_limit: 1_048_576 }, { name: 'models/gemini-2.5-pro' }] });
      },
    });
    expect(models.map((model) => model.id)).toEqual(['gemini-2.0-flash', 'gemini-2.5-pro']);
    expect(models[0]!.contextWindow).toBe(1_048_576);
    expect(calls[0]!.url).toContain('key=g-key');
  });
});

describe('error handling', () => {
  it('surfaces HTTP failures as ModelHttpError with the status', async () => {
    await expect(listProviderModels({
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      fetch: async () => jsonResponse(401, { error: { message: 'bad key' } }),
    })).rejects.toMatchObject({ name: 'ModelHttpError', status: 401 });
  });

  it('times out honestly', async () => {
    await expect(listProviderModels({
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      timeoutMs: 30,
      fetch: (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const abortError = new Error('The operation was aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      }),
    })).rejects.toSatisfy((error: unknown) => error instanceof Error && /timed out/.test(error.message));
  });

  it('rejects malformed payloads instead of returning garbage', async () => {
    await expect(listProviderModels({
      protocol: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      fetch: async () => jsonResponse(200, { unexpected: true }),
    })).rejects.toSatisfy((error: unknown) => error instanceof Error && /Unexpected model-list payload/.test(error.message));
  });
});

describe('sortRemoteModels', () => {
  it('is case-insensitive and does not mutate the input', () => {
    const input = [{ id: 'Beta' }, { id: 'alpha' }];
    const sorted = sortRemoteModels(input);
    expect(sorted.map((model) => model.id)).toEqual(['alpha', 'Beta']);
    expect(input[0]!.id).toBe('Beta');
  });
});
