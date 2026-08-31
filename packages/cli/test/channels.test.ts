import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import { createWebhookServer, listenWebhook, runTelegramLoop, sendTelegramMessage, verifySecret } from '../src/channels/channels.js';

async function withWebhook(secret: string | undefined, fn: (base: string) => Promise<void>): Promise<void> {
  const runner = async (text: string, sender: string) => `echo:${sender}:${text}`;
  const server = createWebhookServer({ runner, secret });
  const port = await listenWebhook(server);
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test('webhook healthz and routing', async () => {
  await withWebhook(undefined, async (base) => {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: 'agentforge-webhook' });
    assert.equal((await fetch(`${base}/nope`, { method: 'POST' })).status, 404);
  });
});

test('webhook runs the prompt and returns the reply', async () => {
  await withWebhook(undefined, async (base) => {
    const response = await fetch(`${base}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender: 'alice', text: 'hello channel' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { reply: 'echo:alice:hello channel', sender: 'alice' });
    const missing = await fetch(`${base}/hook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"sender":"bob"}' });
    assert.equal(missing.status, 400);
  });
});

test('shared-secret verification: header and HMAC signature paths', async () => {
  const secret = 's3cr3t';
  const mockRequest = (headers: Record<string, string>) => ({ headers }) as never;
  assert.equal(verifySecret(undefined, mockRequest({}), 'body'), true, 'no secret configured accepts all');
  assert.equal(verifySecret(secret, mockRequest({ 'x-agentforge-secret': secret }), 'body'), true, 'header path');
  const body = '{"text":"hi"}';
  const goodSig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifySecret(secret, mockRequest({ 'x-signature': goodSig }), body), true, 'HMAC path');
  assert.equal(verifySecret(secret, mockRequest({ 'x-signature': 'sha256=deadbeef' }), body), false, 'bad HMAC rejected');
  assert.equal(verifySecret(secret, mockRequest({}), body), false, 'no credentials rejected');
  await withWebhook(secret, async (base) => {
    const denied = await fetch(`${base}/hook`, { method: 'POST', body: JSON.stringify({ text: 'hi' }), headers: { 'content-type': 'application/json' } });
    assert.equal(denied.status, 401);
    const accepted = await fetch(`${base}/hook`, { method: 'POST', body: JSON.stringify({ text: 'hi' }), headers: { 'content-type': 'application/json', 'x-agentforge-secret': secret } });
    assert.equal(accepted.status, 200);
  });
});

test('telegram loop: dispatch, reply, chat allowlist, and error resilience', async () => {
  const sent: Array<{ chatId: number; text: string }> = [];
  const originalFetch = globalThis.fetch;
  const updates = [
    { update_id: 1, message: { chat: { id: 111, first_name: 'Ada' }, text: 'hello bot', from: { username: 'ada' } } },
    { update_id: 2, message: { chat: { id: 999, first_name: 'Mallory' }, text: 'sneaky' } },
    { update_id: 3, message: { chat: { id: 111 }, text: '' } },
  ];
  let pollCount = 0;
  globalThis.fetch = (async (url: string | URL, init?: { body?: string }) => {
    const method = String(url).split('/').at(-1);
    if (method === 'getUpdates') {
      pollCount += 1;
      if (pollCount > 1) throw new Error('stop polling');
      return new Response(JSON.stringify({ ok: true, result: updates }), { status: 200 });
    }
    if (method === 'sendMessage') {
      const body = JSON.parse(init?.body ?? '{}') as { chat_id: number; text: string };
      sent.push({ chatId: body.chat_id, text: body.text });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    throw new Error(`unexpected method ${method}`);
  }) as typeof fetch;
  try {
    const errors: Error[] = [];
    const controller = new AbortController();
    // Abort while the loop waits after the injected poll failure.
    setTimeout(() => controller.abort(), 150);
    const offset = await runTelegramLoop({
      token: 'test-token',
      runner: async (text, sender) => `reply-to:${sender}:${text}`,
      allowedChatIds: new Set([111]),
      signal: controller.signal,
      pollSeconds: 0,
    }, (error) => errors.push(error));
    assert.equal(sent.length, 1, 'only the allowed chat got a reply');
    assert.deepEqual(sent[0], { chatId: 111, text: 'reply-to:ada:hello bot' });
    assert.ok(offset >= 3, 'offset advanced past all updates');
    assert.ok(errors.length >= 1, 'poll failure surfaced through onError');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sendTelegramMessage throws honest errors on API failure', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, description: 'chat not found' }), { status: 400 })) as typeof fetch;
  try {
    await assert.rejects(() => sendTelegramMessage('t', 1, 'x'), /chat not found/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
