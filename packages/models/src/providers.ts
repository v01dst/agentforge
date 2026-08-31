import type { Message, ModelChunk, ModelProvider, ModelRequest, ModelResponse, ToolCall, TokenUsage } from '@agentforge-oss/core';

export interface HttpModelOptions { apiKey?: string; baseUrl?: string; fetch?: typeof globalThis.fetch; headers?: Record<string, string>; }

/** Typed HTTP failure so callers can classify retries instead of parsing messages. */
export class ModelHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Retry-After hint in milliseconds when the server sent one (seconds form). */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ModelHttpError';
  }
  /** 429 and 5xx are transient; auth/permission/not-found failures are not. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

const id = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const usage = (input = 0, output = 0): TokenUsage => ({ inputTokens: input, outputTokens: output, totalTokens: input + output });
const asString = (value: unknown): string => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);

export class MockModel implements ModelProvider {
  readonly provider = 'mock';
  readonly model: string;
  private index = 0;
  constructor(private readonly options: { responses?: string[]; model?: string; toolCalls?: ToolCall[][]; latencyMs?: number } = {}) { this.model = options.model ?? 'mock-v1'; }
  async generate(request: ModelRequest): Promise<ModelResponse> {
    if (request.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (this.options.latencyMs) await new Promise((resolve) => setTimeout(resolve, this.options.latencyMs));
    const response = this.options.responses?.[this.index % this.options.responses.length] ?? `Mock response: ${request.messages.at(-1)?.content ?? ''}`;
    const calls = this.options.toolCalls?.[this.index]; this.index += 1;
    return { id: id('mock'), content: response, toolCalls: calls, finishReason: calls?.length ? 'tool_calls' : 'stop', usage: usage(Math.ceil(JSON.stringify(request.messages).length / 4), Math.ceil(response.length / 4)), model: this.model };
  }
  async *stream(request: ModelRequest): AsyncIterable<ModelChunk> { const response = await this.generate(request); for (const token of response.content.split(/(\s+)/)) yield { id: response.id, delta: token }; yield { id: response.id, delta: '', done: true, usage: response.usage }; }
}

export class OpenAIModel implements ModelProvider {
  readonly provider = 'openai';
  readonly model: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly options: HttpModelOptions;
  constructor(options: { model?: string } & HttpModelOptions = {}) { this.model = options.model ?? 'gpt-4o-mini'; this.options = options; this.fetcher = options.fetch ?? globalThis.fetch; }
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const apiKey = this.options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey && !this.options.baseUrl) throw new Error('OPENAI_API_KEY is required for the OpenAI provider');
    const response = await this.fetcher(`${this.options.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...this.options.headers }, body: JSON.stringify({ model: request.model ?? this.model, messages: request.messages, temperature: request.temperature, max_tokens: request.maxTokens, tools: request.tools?.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })), response_format: request.responseFormat?.type === 'json' ? { type: 'json_object' } : undefined }), signal: request.signal });
    return parseOpenAI(await parseResponse(response), this.model);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
    const apiKey = this.options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey && !this.options.baseUrl) throw new Error('OPENAI_API_KEY is required for the OpenAI provider');
    const response = await this.fetcher(`${this.options.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...this.options.headers },
      body: JSON.stringify({
        model: request.model ?? this.model,
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        tools: request.tools?.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
      }),
      signal: request.signal,
    });
    if (!response.ok) await parseResponse(response); // throws the typed ModelHttpError
    yield* emitStream(this.openAiParts(response), id('openai'));
  }

  private async *openAiParts(response: Response): AsyncGenerator<StreamPart, void, unknown> {
    // Streamed tool calls arrive as index-keyed fragments; accumulate and
    // assemble them once at the end instead of parsing partial JSON per chunk.
    const tools = new Map<number, { id?: string; name?: string; arguments: string }>();
    for await (const event of sseEvents(response)) {
      const data = sseData(event);
      if (!data || data === '[DONE]') continue;
      let parsed: {
        id?: string;
        choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try { parsed = JSON.parse(data); } catch { continue; }
      const choice = parsed.choices?.[0];
      for (const call of choice?.delta?.tool_calls ?? []) {
        const index = call.index ?? 0;
        const slot = tools.get(index) ?? { arguments: '' };
        if (call.id) slot.id = call.id;
        if (call.function?.name) slot.name = call.function.name;
        if (call.function?.arguments) slot.arguments += call.function.arguments;
        tools.set(index, slot);
      }
      yield {
        text: choice?.delta?.content ?? undefined,
        usage: parsed.usage ? usage(parsed.usage.prompt_tokens, parsed.usage.completion_tokens) : undefined,
        raw: parsed,
      };
    }
    if (tools.size) {
      yield {
        toolCalls: [...tools.entries()]
          .sort((left, right) => left[0] - right[0])
          .map(([, slot]) => ({ id: slot.id ?? id('tool'), name: slot.name ?? '', arguments: parseArgs(slot.arguments) })),
      };
    }
  }
}

export class AnthropicModel implements ModelProvider {
  readonly provider = 'anthropic';
  readonly model: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly options: HttpModelOptions;
  constructor(options: { model?: string } & HttpModelOptions = {}) { this.model = options.model ?? 'claude-3-5-sonnet-latest'; this.options = options; this.fetcher = options.fetch ?? globalThis.fetch; }
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const apiKey = this.options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for the Anthropic provider');
    // Prompt caching (Phase D): the stable system prefix gets a cache
    // breakpoint so repeat turns read the prefix from the provider cache.
    const system = request.messages.find((message) => message.role === 'system')?.content;
    const messages = request.messages.filter((message) => message.role !== 'system').map((message) => ({ role: message.role === 'tool' ? 'user' : message.role, content: message.content }));
    const systemBlock = system !== undefined ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined;
    const response = await this.fetcher(`${this.options.baseUrl ?? 'https://api.anthropic.com/v1'}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', ...this.options.headers }, body: JSON.stringify({ model: request.model ?? this.model, max_tokens: request.maxTokens ?? 1024, system: systemBlock, messages, temperature: request.temperature, tools: request.tools?.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) }), signal: request.signal });
    const body = await parseResponse(response) as { id?: string; content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } };
    const calls = body.content?.filter((item) => item.type === 'tool_use').map((item) => ({ id: item.id ?? id('tool'), name: item.name ?? '', arguments: item.input })) ?? [];
    return { id: body.id ?? id('anthropic'), content: body.content?.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('') ?? '', toolCalls: calls.length ? calls : undefined, finishReason: calls.length ? 'tool_calls' : 'stop', usage: usage(body.usage?.input_tokens, body.usage?.output_tokens), model: this.model, raw: body };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
    const apiKey = this.options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for the Anthropic provider');
    const system = request.messages.find((message) => message.role === 'system')?.content;
    const messages = request.messages.filter((message) => message.role !== 'system').map((message) => ({ role: message.role === 'tool' ? 'user' : message.role, content: message.content }));
    const systemBlock = system !== undefined ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined;
    const response = await this.fetcher(`${this.options.baseUrl ?? 'https://api.anthropic.com/v1'}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', ...this.options.headers },
      body: JSON.stringify({
        model: request.model ?? this.model,
        max_tokens: request.maxTokens ?? 1024,
        system: systemBlock,
        messages,
        temperature: request.temperature,
        stream: true,
        tools: request.tools?.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
      }),
      signal: request.signal,
    });
    if (!response.ok) await parseResponse(response);
    yield* emitStream(this.anthropicParts(response), id('anthropic'));
  }

  private async *anthropicParts(response: Response): AsyncGenerator<StreamPart, void, unknown> {
    let inputTokens = 0;
    let outputTokens = 0;
    const tools: ToolCall[] = [];
    for await (const event of sseEvents(response)) {
      const data = sseData(event);
      if (!data) continue;
      let parsed: {
        type?: string;
        message?: { id?: string; usage?: { input_tokens?: number; output_tokens?: number } };
        content_block?: { type?: string; id?: string; name?: string };
        delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      try { parsed = JSON.parse(data); } catch { continue; }
      if (parsed.type === 'message_start') inputTokens = parsed.message?.usage?.input_tokens ?? 0;
      if (parsed.type === 'content_block_delta') {
        if (parsed.delta?.type === 'text_delta' && parsed.delta.text) yield { text: parsed.delta.text };
        if (parsed.delta?.type === 'input_json_delta') {
          // Fragments accumulate onto the last started tool_use block.
          const last = tools[tools.length - 1];
          if (last) last.arguments = { __json: ((last.arguments as { __json?: string } | undefined)?.__json ?? '') + (parsed.delta.partial_json ?? '') };
        }
      }
      if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
        tools.push({ id: parsed.content_block.id ?? id('tool'), name: parsed.content_block.name ?? '', arguments: { __json: '' } });
      }
      if (parsed.type === 'message_delta') {
        outputTokens = parsed.usage?.output_tokens ?? outputTokens;
      }
      if (parsed.type === 'message_stop') break;
    }
    if (tools.length) {
      yield {
        toolCalls: tools.map((tool) => {
          const json = (tool.arguments as { __json?: string }).__json ?? '';
          let parsedArgs: unknown = {};
          try { parsedArgs = json ? JSON.parse(json) : {}; } catch { parsedArgs = { value: json }; }
          return { id: tool.id, name: tool.name, arguments: parsedArgs };
        }),
      };
    }
    if (inputTokens || outputTokens) yield { usage: usage(inputTokens, outputTokens) };
  }
}

export class GeminiModel implements ModelProvider {
  readonly provider = 'google';
  readonly model: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly options: HttpModelOptions;
  constructor(options: { model?: string } & HttpModelOptions = {}) { this.model = options.model ?? 'gemini-1.5-flash'; this.options = options; this.fetcher = options.fetch ?? globalThis.fetch; }
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const key = this.options.apiKey ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? '';
    if (!key) throw new Error('GOOGLE_API_KEY or GEMINI_API_KEY is required for the Gemini provider');
    const endpoint = `${this.options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'}/models/${request.model ?? this.model}:generateContent?key=${encodeURIComponent(key)}`;
    const contents = request.messages.filter((message) => message.role !== 'system').map((message) => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] }));
    const response = await this.fetcher(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...this.options.headers }, body: JSON.stringify({ contents, systemInstruction: request.messages.find((message) => message.role === 'system') ? { parts: [{ text: request.messages.find((message) => message.role === 'system')?.content }] } : undefined, generationConfig: { temperature: request.temperature, maxOutputTokens: request.maxTokens } }), signal: request.signal });
    const body = await parseResponse(response) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }> }; finishReason?: string }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
    const parts = body.candidates?.[0]?.content?.parts ?? []; const calls = parts.filter((part) => part.functionCall).map((part) => ({ id: id('gemini-tool'), name: part.functionCall?.name ?? '', arguments: part.functionCall?.args ?? {} }));
    const content = parts.filter((part) => part.text).map((part) => part.text).join('');
    return { id: id('gemini'), content, toolCalls: calls.length ? calls : undefined, finishReason: calls.length ? 'tool_calls' : 'stop', usage: usage(body.usageMetadata?.promptTokenCount, body.usageMetadata?.candidatesTokenCount), model: this.model, raw: body };
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelChunk> {
    const key = this.options.apiKey ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? '';
    if (!key) throw new Error('GOOGLE_API_KEY or GEMINI_API_KEY is required for the Gemini provider');
    const endpoint = `${this.options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'}/models/${request.model ?? this.model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
    const contents = request.messages.filter((message) => message.role !== 'system').map((message) => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] }));
    const response = await this.fetcher(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...this.options.headers },
      body: JSON.stringify({
        contents,
        systemInstruction: request.messages.find((message) => message.role === 'system') ? { parts: [{ text: request.messages.find((message) => message.role === 'system')?.content }] } : undefined,
        generationConfig: { temperature: request.temperature, maxOutputTokens: request.maxTokens },
      }),
      signal: request.signal,
    });
    if (!response.ok) await parseResponse(response);
    yield* emitStream(this.geminiParts(response), id('gemini'));
  }

  private async *geminiParts(response: Response): AsyncGenerator<StreamPart, void, unknown> {
    const toolCalls: ToolCall[] = [];
    let usageMetadata: { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
    for await (const event of sseEvents(response)) {
      const data = sseData(event);
      if (!data) continue;
      let parsed: {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }> } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      try { parsed = JSON.parse(data); } catch { continue; }
      usageMetadata = parsed.usageMetadata ?? usageMetadata;
      const parts = parsed.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (part.text) yield { text: part.text };
        if (part.functionCall) toolCalls.push({ id: id('gemini-tool'), name: part.functionCall.name ?? '', arguments: part.functionCall.args ?? {} });
      }
    }
    if (toolCalls.length) yield { toolCalls };
    if (usageMetadata) yield { usage: usage(usageMetadata.promptTokenCount, usageMetadata.candidatesTokenCount) };
  }
}

export interface CreateModelOptions { provider: 'openai' | 'anthropic' | 'google' | 'gemini' | 'mock' | 'openai-compatible' | 'custom' | ModelProvider; model?: string; apiKey?: string; baseUrl?: string; fetch?: typeof globalThis.fetch; responses?: string[]; }
export function createModel(options: CreateModelOptions): ModelProvider {
  if (typeof options.provider !== 'string') return options.provider;
  switch (options.provider) {
    case 'openai': return new OpenAIModel(options);
    case 'anthropic': return new AnthropicModel(options);
    case 'google': case 'gemini': return new GeminiModel(options);
    case 'mock': return new MockModel(options);
    case 'openai-compatible':
    case 'custom': {
      if (!options.baseUrl) throw new Error("The 'openai-compatible' provider requires a baseUrl (for example https://openrouter.ai/api/v1).");
      return new OpenAIModel(options);
    }
    default: throw new Error(`Unsupported model provider: ${options.provider as string}`);
  }
}

/** Wire protocol a custom/proxy endpoint speaks. */
export type ProviderProtocol = 'openai' | 'anthropic' | 'google' | 'gemini' | 'openai-compatible';

/**
 * A named, configurable model endpoint. API keys are resolved from the
 * environment (`apiKeyEnv`); secrets must never be stored in config files.
 */
export interface ProviderDefinition {
  name?: string;
  protocol: ProviderProtocol;
  /** Default model id for this endpoint, e.g. `gpt-4o-mini`. */
  model?: string;
  /** Endpoint root, e.g. `https://openrouter.ai/api/v1`. Required for openai-compatible. */
  baseUrl?: string;
  /** Environment variable that holds the API key. Optional for local endpoints. */
  apiKeyEnv?: string;
  /** Explicit key override; intended for tests and in-memory use only. */
  apiKey?: string;
  headers?: Record<string, string>;
  /** Injectable transport, primarily for tests. */
  fetch?: typeof globalThis.fetch;
}

const PROTOCOL_DEFAULT_KEY_ENVS: Record<ProviderProtocol, readonly string[]> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  gemini: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  'openai-compatible': [],
};

function label(definition: ProviderDefinition): string {
  return definition.name ? `provider '${definition.name}'` : `provider ${definition.protocol}`;
}

/** Environment variables consulted for this definition's credential. */
export function requiredKeyEnvs(definition: ProviderDefinition): readonly string[] {
  return definition.apiKeyEnv ? [definition.apiKeyEnv] : PROTOCOL_DEFAULT_KEY_ENVS[definition.protocol];
}

/** Resolve the API key for a definition: explicit option first, then env vars. */
export function resolveApiKey(definition: ProviderDefinition, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (definition.apiKey) return definition.apiKey;
  for (const name of requiredKeyEnvs(definition)) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

/** Whether a definition has everything it needs to send a request. */
export function isProviderReady(definition: ProviderDefinition, env: NodeJS.ProcessEnv = process.env): boolean {
  if (definition.protocol === 'openai-compatible') {
    if (!definition.baseUrl) return false;
    return !definition.apiKeyEnv || Boolean(env[definition.apiKeyEnv]);
  }
  if (definition.baseUrl && definition.apiKey) return true;
  return resolveApiKey(definition, env) !== undefined;
}

/** Build a ModelProvider from a named definition using environment credentials. */
export function createConfiguredModel(definition: ProviderDefinition, env: NodeJS.ProcessEnv = process.env): ModelProvider {
  const who = label(definition);
  const options = {
    model: definition.model,
    baseUrl: definition.baseUrl,
    headers: definition.headers,
    apiKey: resolveApiKey(definition, env),
    fetch: definition.fetch,
  };
  switch (definition.protocol) {
    case 'openai': return new OpenAIModel(options);
    case 'anthropic': return new AnthropicModel(options);
    case 'google': case 'gemini': return new GeminiModel(options);
    case 'openai-compatible': {
      if (!definition.baseUrl) throw new Error(`${who}: protocol 'openai-compatible' requires a baseUrl (for example https://openrouter.ai/api/v1).`);
      return new OpenAIModel(options);
    }
    default: throw new Error(`${who}: unsupported protocol ${(definition as { protocol?: string }).protocol ?? 'unknown'}`);
  }
}

function retryAfterMsOf(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
  if (!response.ok) {
    throw new ModelHttpError(
      response.status,
      `Model provider request failed (${response.status}): ${asString((body as { error?: unknown }).error ?? text)}`,
      retryAfterMsOf(response),
    );
  }
  return body;
}

/** Yields raw SSE events (whitespace-normalized) from a fetch response body. */
async function* sseEvents(response: Response): AsyncGenerator<string> {
  const body = response.body;
  if (!body) throw new ModelHttpError(response.status, 'Streaming response has no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        yield buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
    }
    if (buffer.trim()) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

/** Extracts the concatenated data payload of one SSE event. */
function sseData(event: string): string | undefined {
  const lines = event.split('\n').filter((line) => line.startsWith('data:'));
  if (!lines.length) return undefined;
  return lines.map((line) => line.slice(5).trim()).join('\n');
}

interface StreamPart {
  text?: string;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
  raw?: unknown;
}

/** Shared streaming assembly: collect text deltas, emit assembled tool calls, then done. */
async function* emitStream(source: AsyncGenerator<StreamPart, void, unknown>, fallbackId: string): AsyncGenerator<ModelChunk> {
  let streamId = fallbackId;
  const pending: ToolCall[] = [];
  for await (const part of source) {
    if (part.raw && typeof (part.raw as { id?: unknown }).id === 'string') streamId = (part.raw as { id: string }).id;
    if (part.text) yield { id: streamId, delta: part.text };
    if (part.toolCalls?.length) pending.push(...part.toolCalls);
    if (part.usage) yield { id: streamId, delta: '', usage: part.usage };
  }
  for (const call of pending) yield { id: streamId, delta: '', toolCall: call };
  yield { id: streamId, delta: '', done: true };
}

function parseOpenAI(body: unknown, model: string): ModelResponse { const value = body as { id?: string; choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }; const message = value.choices?.[0]?.message; const calls = message?.tool_calls?.map((call) => ({ id: call.id ?? id('tool'), name: call.function?.name ?? '', arguments: parseArgs(call.function?.arguments) })) ?? []; const finish = value.choices?.[0]?.finish_reason; return { id: value.id ?? id('openai'), content: message?.content ?? '', toolCalls: calls.length ? calls : undefined, finishReason: calls.length ? 'tool_calls' : finish === 'length' ? 'length' : 'stop', usage: usage(value.usage?.prompt_tokens, value.usage?.completion_tokens), model, raw: body }; }
function parseArgs(value?: string): unknown { if (!value) return {}; try { return JSON.parse(value); } catch { return { value }; } }
