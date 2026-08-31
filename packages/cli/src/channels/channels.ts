import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Channel adapters (Phase L): pipe inbound chat messages from external
 * channels into an AgentForge runner and reply outbound.
 *
 * - `webhook`: a generic HTTP webhook. Inbound POST /hook with
 *   `{ sender, text }` (or any JSON with text) runs the prompt and returns
 *   `{ reply }`. Optional shared-secret verification via
 *   `X-AgentForge-Secret` or HMAC-SHA256 of the raw body
 *   (`X-Signature: sha256=<hex>`).
 * - `telegram`: long-polling adapter (no inbound ports needed) speaking the
 *   Bot API — `getUpdates` offset loop, `sendMessage` replies. Token comes
 *   from `--token` or `TELEGRAM_BOT_TOKEN`; allowed chat ids can be
 *   restricted.
 *
 * Both adapters are thin transports: policy, sessions, and logging stay in
 * the runner.
 */

export interface WebhookOptions {
  runner: WebhookRunner;
  /** Shared secret; when set, requests must present it. */
  secret?: string;
}

/** Minimal runner seam for channel adapters. */
export type WebhookRunner = (text: string, sender: string) => Promise<string>;

export function verifySecret(secret: string | undefined, request: IncomingMessage, rawBody: string): boolean {
  if (!secret) return true;
  const header = request.headers['x-agentforge-secret'];
  if (typeof header === 'string' && header === secret) return true;
  const signature = request.headers['x-signature'];
  if (typeof signature === 'string') {
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const presented = signature.startsWith('sha256=') ? signature.slice(7) : signature;
    const a = Buffer.from(expected);
    const b = Buffer.from(presented);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

function replyJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

async function readBody(request: IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { rejectBody(new Error('Request body too large.')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    request.on('error', rejectBody);
  });
}

export function createWebhookServer(options: WebhookOptions): Server {
  return createServer((request, response) => {
    void handle(request, response).catch(() => replyJson(response, 500, { error: 'internal error' }));
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = (request.url ?? '/').split('?')[0]!;
    if (request.method === 'GET' && (url === '/healthz' || url === '/')) {
      replyJson(response, 200, { ok: true, service: 'agentforge-webhook' });
      return;
    }
    if (request.method !== 'POST' || url !== '/hook') {
      replyJson(response, 404, { error: `No route for ${request.method} ${url}` });
      return;
    }
    const raw = await readBody(request);
    if (!verifySecret(options.secret, request, raw)) {
      replyJson(response, 401, { error: 'invalid secret or signature' });
      return;
    }
    let parsed: { text?: unknown; sender?: unknown };
    try {
      parsed = JSON.parse(raw) as { text?: unknown; sender?: unknown };
    } catch {
      replyJson(response, 400, { error: 'malformed JSON body' });
      return;
    }
    const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
    const sender = typeof parsed.sender === 'string' ? parsed.sender : 'webhook';
    if (!text) {
      replyJson(response, 400, { error: 'missing "text" field' });
      return;
    }
    try {
      const reply = await options.runner(text, sender);
      replyJson(response, 200, { reply, sender });
    } catch (error) {
      replyJson(response, 200, { reply: `error: ${error instanceof Error ? error.message : 'runner failed'}`, sender });
    }
  }
}

export function listenWebhook(server: Server, port = 0, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      const address = server.address();
      resolveListen(address && typeof address === 'object' ? address.port : port);
    });
  });
}

// ---------------------------------------------------------------------------
// Telegram long-polling adapter
// ---------------------------------------------------------------------------

export interface TelegramOptions {
  token: string;
  runner: WebhookRunner;
  /** Restrict to these chat ids when provided. */
  allowedChatIds?: ReadonlySet<number>;
  /** Poll timeout seconds (Bot API long-poll). */
  pollSeconds?: number;
  signal?: AbortSignal;
}

export interface TelegramUpdate {
  update_id: number;
  message?: { chat: { id: number; first_name?: string }; text?: string; from?: { username?: string } };
}

async function telegramApi<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json() as { ok: boolean; result?: T; description?: string };
  if (!payload.ok) throw new Error(`Telegram API ${method} failed: ${payload.description ?? response.status}`);
  return payload.result as T;
}

export async function sendTelegramMessage(token: string, chatId: number, text: string): Promise<void> {
  await telegramApi(token, 'sendMessage', { chat_id: chatId, text: text.slice(0, 4000) });
}

/**
 * Long-polling loop: fetch updates, dispatch each text message to the
 * runner, send the reply back. Returns the final offset. Errors are logged
 * via `onError` and the loop retries — a dead bot never crashes the host.
 */
export async function runTelegramLoop(options: TelegramOptions, onError: (error: Error) => void = () => {}): Promise<number> {
  const pollSeconds = options.pollSeconds ?? 25;
  let offset = 0;
  for (;;) {
    if (options.signal?.aborted) break;
    let updates: TelegramUpdate[];
    try {
      updates = await telegramApi<TelegramUpdate[]>(options.token, 'getUpdates', {
        offset: offset || undefined,
        timeout: pollSeconds,
        allowed_updates: ['message'],
      });
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
      if (options.signal?.aborted) break;
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, 3000);
        options.signal?.addEventListener('abort', () => { clearTimeout(timer); resolveWait(); }, { once: true });
      });
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1;
      const message = update.message;
      if (!message?.text) continue;
      if (options.allowedChatIds && !options.allowedChatIds.has(message.chat.id)) continue;
      const sender = message.from?.username ?? message.chat.first_name ?? String(message.chat.id);
      let reply: string;
      try {
        reply = await options.runner(message.text, sender);
      } catch (error) {
        reply = `error: ${error instanceof Error ? error.message : 'runner failed'}`;
      }
      try {
        await sendTelegramMessage(options.token, message.chat.id, reply);
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
  return offset;
}
