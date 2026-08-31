import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';

/**
 * Gateway (Phase J): expose an AgentForge agent as an OpenAI-compatible
 * endpoint. One durable seam: POST /v1/chat/completions (streaming and not)
 * and GET /healthz. Clean-room implementation on node:http — the OpenAI
 * wire format is a protocol, not a codebase to copy.
 *
 * Requests map 1:1 onto core Messages; the backing model is injected
 * (`modelInstance`) so tests are deterministic without a network.
 */

export interface GatewayOptions {
  port?: number;
  host?: string;
  /** Backing ModelProvider (injected in tests; built from config otherwise). */
  modelInstance: unknown;
  /** Default model name reported in responses. */
  model?: string;
  /** Optional per-request transform: returns extra system context per conversation. */
  buildInstructions?: () => string | undefined;
}

const CHAT_REQUEST = z.object({
  model: z.string().optional(),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string(),
  })).min(1),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
});

export type ChatMessage = z.infer<typeof CHAT_REQUEST>['messages'][number];

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{ index: number; message: { role: 'assistant'; content: string }; finish_reason: 'stop' }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

const CHAT_ERROR = { object: 'chat.completion.error' } as const;

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

function tokenEstimate(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function completionId(): string {
  return `chatcmpl-${randomBytes(12).toString('hex')}`;
}

/** Core request builder shared by streaming and non-streaming paths. */
function toModelRequest(parsed: z.infer<typeof CHAT_REQUEST>, options: GatewayOptions): unknown {
  const messages: Array<{ role: string; content: string }> = [];
  const instructions = options.buildInstructions?.();
  if (instructions) messages.push({ role: 'system', content: instructions });
  messages.push(...parsed.messages);
  return {
    messages,
    model: parsed.model ?? options.model,
    temperature: parsed.temperature,
    maxTokens: parsed.max_tokens,
  };
}

async function readBody(request: IncomingMessage, maxBytes = 2_000_000): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        rejectBody(new Error('Request body too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    request.on('error', rejectBody);
  });
}

export function createGatewayServer(options: GatewayOptions): Server {
  const model = options.model ?? 'agentforge';
  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      sendJson(response, 500, { error: { message: error instanceof Error ? error.message : String(error), ...CHAT_ERROR } });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = (request.url ?? '/').split('?')[0]!;
    if (request.method === 'GET' && (url === '/healthz' || url === '/')) {
      sendJson(response, 200, { ok: true, service: 'agentforge-gateway', model });
      return;
    }

    if (request.method !== 'POST' || url !== '/v1/chat/completions') {
      sendJson(response, 404, { error: { message: `No route for ${request.method} ${url}`, ...CHAT_ERROR } });
      return;
    }

    let parsed: z.infer<typeof CHAT_REQUEST>;
    try {
      parsed = CHAT_REQUEST.parse(JSON.parse(await readBody(request)));
    } catch (error) {
      sendJson(response, 400, { error: { message: error instanceof Error ? error.message : 'Malformed request body.', ...CHAT_ERROR } });
      return;
    }

    const backing = options.modelInstance as { generate?: (request: unknown) => Promise<{ content?: string; usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number } }>; stream?: (request: unknown) => AsyncIterable<{ text?: string }> };
    if (!backing || typeof backing.generate !== 'function') {
      sendJson(response, 500, { error: { message: 'Gateway has no backing model configured.', ...CHAT_ERROR } });
      return;
    }

    const modelRequest = toModelRequest(parsed, options);

    if (parsed.stream && typeof backing.stream === 'function') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const id = completionId();
      let text = '';
      try {
        for await (const chunk of backing.stream(modelRequest)) {
          if (!chunk.text) continue;
          text += chunk.text;
          response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }] })}\n\n`);
        }
      } catch (error) {
        response.write(`data: ${JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error), ...CHAT_ERROR } })}\n\n`);
      }
      response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      response.write('data: [DONE]\n\n');
      response.end();
      void text;
      return;
    }

    const result = await backing.generate(modelRequest);
    const content = result?.content ?? '';
    const usage = {
      prompt_tokens: result?.usage?.inputTokens ?? 0,
      completion_tokens: result?.usage?.outputTokens ?? tokenEstimate(content),
      total_tokens: result?.usage?.totalTokens ?? tokenEstimate(content),
    };
    const payload: ChatCompletionResponse = {
      id: completionId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: parsed.model ?? model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage,
    };
    sendJson(response, 200, payload);
  }
}

/** Listen on an ephemeral port; resolves with the bound port. */
export function listenGateway(server: Server, port = 0, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      const address = server.address();
      if (address && typeof address === 'object') resolveListen(address.port);
      else resolveListen(port);
    });
  });
}
