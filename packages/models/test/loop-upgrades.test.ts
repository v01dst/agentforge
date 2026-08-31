import { describe, expect, it } from 'vitest';
import { createModel } from '../src/index.js';
import { createCompressionInterceptor } from '../../cli/src/context/compression.js';
import type { Message, ModelRequest } from '@agentforge-oss/core';

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

const requestOf = { messages: [{ role: 'user' as const, content: 'hi' }] };

describe('Phase D: prompt caching', () => {
  it('anthropic sends the system prompt as a cache_control block', async () => {
    const stub = fetchStub(() => ({ body: { id: 'a1', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} } }));
    const model = createModel({ provider: 'anthropic', apiKey: 'k', fetch: stub.fetch });
    await model.generate({ messages: [{ role: 'system', content: 'You are AgentForge.' }, { role: 'user', content: 'hi' }] });
    const body = JSON.parse(String(stub.calls[0]!.init.body));
    expect(body.system).toEqual([{ type: 'text', text: 'You are AgentForge.', cache_control: { type: 'ephemeral' } }]);
  });

  it('openai requests stay unchanged (no anthropic cache fields)', async () => {
    const stub = fetchStub(() => ({ body: { id: 'o1', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} } }));
    const model = createModel({ provider: 'openai', apiKey: 'k', fetch: stub.fetch });
    await model.generate({ messages: [{ role: 'system', content: 'sys' }, ...requestOf.messages] });
    const body = JSON.parse(String(stub.calls[0]!.init.body));
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
  });
});

describe('Phase D: live context compression', () => {
  const long = (text: string): Message => ({ role: 'user', content: text });

  it('folds the middle of oversized conversations, keeping system + recent tail', async () => {
    const interceptor = createCompressionInterceptor({ maxChars: 500, keepRecent: 3, foldTextCap: 40 });
    const messages: Message[] = [
      { role: 'system', content: 'SYSTEM PROMPT' },
      long('m'.repeat(200)),
      { role: 'assistant', content: 'a'.repeat(200) },
      { role: 'tool', content: 't'.repeat(200), name: 'read_file', toolCallId: 't1' },
      long('recent one'),
      { role: 'assistant', content: 'recent two' },
      long('recent three'),
    ];
    const result = await interceptor({ messages } as unknown as ModelRequest);
    expect(result).toBeDefined();
    const folded = result!.messages;
    expect(folded[0]!.content).toBe('SYSTEM PROMPT');
    expect(folded[1]!.content).toContain('[context compacted');
    expect(folded[1]!.content).toContain('3 earlier message(s)');
    // Tail is verbatim.
    expect(folded.at(-1)!.content).toBe('recent three');
    expect(folded.at(-2)!.content).toBe('recent two');
    expect(folded.length).toBe(3 + 2); // system + marker + tail
  });

  it('leaves short conversations untouched', async () => {
    const interceptor = createCompressionInterceptor({ maxChars: 10_000, keepRecent: 3 });
    const messages: Message[] = [{ role: 'system', content: 'sys' }, long('hello')];
    expect(await interceptor({ messages } as unknown as ModelRequest)).toBeUndefined();
  });
});
