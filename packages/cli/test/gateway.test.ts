import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createGatewayServer, listenGateway } from '../src/gateway/server.js';
import type { Server } from 'node:http';

interface Context { server?: Server; base?: string }

async function withGateway(fn: (base: string, modelCalls: { received: unknown[] }) => Promise<void>): Promise<void> {
  const modelCalls: { received: unknown[] } = { received: [] };
  const mockModel = {
    async generate(request: unknown) {
      modelCalls.received.push(request);
      return { id: 'mock-1', content: `mock-reply:${(request as { messages: Array<{ content: string }> }).messages.at(-1)?.content ?? ''}`, usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 } };
    },
    async *stream(request: unknown) {
      modelCalls.received.push(request);
      yield { text: 'streamed-' };
      yield { text: 'reply' };
    },
  };
  const server = createGatewayServer({ modelInstance: mockModel, model: 'mock-1', buildInstructions: () => 'You are AgentForge.' });
  const port = await listenGateway(server);
  try {
    await fn(`http://127.0.0.1:${port}`, modelCalls);
  } finally {
    server.close();
  }
}

test('GET /healthz reports service and model', async () => {
  await withGateway(async (base) => {
    const response = await fetch(`${base}/healthz`);
    assert.equal(response.status, 200);
    const body = await response.json() as { ok: boolean; service: string; model: string };
    assert.equal(body.ok, true);
    assert.equal(body.service, 'agentforge-gateway');
    assert.equal(body.model, 'mock-1');
  });
});

test('POST /v1/chat/completions returns OpenAI-shaped completions', async () => {
  await withGateway(async (base, modelCalls) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello gateway' }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { id: string; object: string; choices: Array<{ message: { role: string; content: string } }>; usage: { total_tokens: number } };
    assert.match(body.id, /^chatcmpl-/);
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0]!.message.role, 'assistant');
    assert.equal(body.choices[0]!.message.content, 'mock-reply:hello gateway');
    assert.equal(body.usage.total_tokens, 12);
    // The gateway prepends the built system instruction.
    const sent = modelCalls.received[0] as { messages: Array<{ role: string; content: string }> };
    assert.equal(sent.messages[0]!.role, 'system');
    assert.match(sent.messages[0]!.content, /AgentForge/);
  });
});

test('streaming requests return SSE chunks terminated by [DONE]', async () => {
  await withGateway(async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const raw = await response.text();
    const events = raw.split('\n').filter((line) => line.startsWith('data: '));
    assert.equal(events.at(-1), 'data: [DONE]');
    const deltas = events.slice(0, -1).map((line) => JSON.parse(line.slice(6)) as { choices: Array<{ delta: { content?: string } }> });
    const text = deltas.map((event) => event.choices[0]!.delta.content ?? '').join('');
    assert.equal(text, 'streamed-reply');
    const last = deltas.at(-1)!;
    assert.equal(last.choices[0]!.delta.content, undefined, 'final chunk carries finish_reason');
  });
});

test('malformed bodies and unknown routes fail with honest errors', async () => {
  await withGateway(async (base) => {
    const bad = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"messages": "nope"}' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json() as { error: { message: string } }).error.message, /Invalid input|Expected|malformed/i);
    const missing = await fetch(`${base}/nope`, { method: 'POST' });
    assert.equal(missing.status, 404);
    const noMessages = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noMessages.status, 400);
  });
});
