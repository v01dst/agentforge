import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { EventBus } from './events.js';
import type { AgentConfig, AgentEvent, AgentResult, AgentRunOptions, Message, ModelChunk, ModelRequest, ModelResponse, ToolCall, ToolExecutionResult, ToolLike } from './types.js';
import { addUsage, AgentForgeError, CancellationError, createRunId, emptyUsage, MaxIterationsError, PermissionDeniedError } from './types.js';

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number | undefined, signal?: AbortSignal): Promise<T> => {
  if (!timeoutMs && !signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => { if (timer) clearTimeout(timer); reject(new CancellationError()); };
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
    if (timeoutMs) timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); reject(new AgentForgeError(`Operation timed out after ${timeoutMs}ms`, 'TIMEOUT')); }, timeoutMs);
    promise.then((value) => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(value); }, (error) => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(error); });
  });
};

export class Agent {
  readonly name: string;
  readonly model: AgentConfig['model'];
  readonly instructions?: string;
  readonly tools: ToolLike[];
  readonly maxIterations: number;
  readonly timeoutMs?: number;
  readonly modelRetries: number;
  readonly allowedToolPermissions: readonly string[];
  readonly responseFormat?: ModelRequest['responseFormat'];
  readonly metadata?: Record<string, unknown>;
  readonly events: EventBus;
  constructor(config: AgentConfig & { events?: EventBus }) {
    this.name = config.name; this.model = config.model; this.instructions = config.instructions;
    this.tools = config.tools ?? []; this.maxIterations = config.maxIterations ?? 8; this.timeoutMs = config.timeoutMs; this.modelRetries = config.modelRetries ?? 1; this.allowedToolPermissions = config.allowedToolPermissions ?? []; this.responseFormat = config.responseFormat; this.metadata = config.metadata; this.events = config.events ?? new EventBus();
  }

  async run(input: string, options: AgentRunOptions = {}): Promise<AgentResult> {
    const runId = createRunId('run'); const started = Date.now(); const maxIterations = options.maxIterations ?? this.maxIterations;
    const controller = new AbortController(); const signal = options.signal ?? controller.signal;
    const messages: Message[] = []; if (this.instructions) messages.push({ role: 'system', content: this.instructions }); messages.push({ role: 'user', content: input });
    let usage = emptyUsage(); let iterations = 0; const toolCalls: ToolExecutionResult[] = [];
    await this.emit({ type: 'agent.started', runId, data: { agent: this.name, input } });
    try {
      while (iterations < maxIterations) {
        if (signal.aborted) throw new CancellationError(); iterations += 1;
        await this.emit({ type: 'model.requested', runId, data: { iteration: iterations, model: this.model.model, provider: this.model.provider } });
        const request: ModelRequest = { messages, model: this.model.model, tools: this.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: schemaToJson(tool.inputSchema) })), signal, metadata: options.metadata, responseFormat: options.responseFormat ?? this.responseFormat };
        const response = await this.generateWithRetries(request, options.timeoutMs ?? this.timeoutMs, signal, runId, iterations);
        usage = addUsage(usage, response.usage); await this.emit({ type: 'model.completed', runId, data: { iteration: iterations, finishReason: response.finishReason, usage: response.usage ?? {} } });
        const assistant: Message = { role: 'assistant', content: response.content, toolCalls: response.toolCalls }; messages.push(assistant);
        if (!response.toolCalls?.length) { validateOutput(response.content, request.responseFormat); const result: AgentResult = { runId, output: response.content, messages, iterations, usage, toolCalls, durationMs: Date.now() - started }; await this.emit({ type: 'agent.completed', runId, data: { output: response.content, iterations, usage, durationMs: result.durationMs } }); return result; }
        for (const call of response.toolCalls) {
          const execution = await this.executeTool(call, runId, signal, options, toolCalls); toolCalls.push(execution);
          messages.push({ role: 'tool', content: execution.error ? `Error: ${execution.error.message}` : JSON.stringify(execution.output), name: call.name, toolCallId: call.id });
        }
      }
      throw new MaxIterationsError(maxIterations);
    } catch (error) { await this.emit({ type: 'agent.failed', runId, data: { error: error instanceof Error ? error.message : String(error), iterations } }); throw error; }
  }

  async *stream(input: string, options: AgentRunOptions = {}): AsyncIterable<ModelChunk> {
    if (!this.model.stream || this.tools.length > 0) {
      const result = await this.run(input, options);
      yield { id: result.runId, delta: result.output, done: true, usage: result.usage };
      return;
    }
    const runId = createRunId('run'); const started = Date.now(); const signal = options.signal ?? new AbortController().signal;
    const messages: Message[] = []; if (this.instructions) messages.push({ role: 'system', content: this.instructions }); messages.push({ role: 'user', content: input });
    await this.emit({ type: 'agent.started', runId, data: { agent: this.name, input, streaming: true } });
    await this.emit({ type: 'model.requested', runId, data: { iteration: 1, model: this.model.model, provider: this.model.provider, streaming: true } });
    let output = ''; let usage = emptyUsage();
    try {
      for await (const chunk of this.model.stream({ messages, model: this.model.model, signal, responseFormat: options.responseFormat ?? this.responseFormat, metadata: options.metadata })) { if (signal.aborted) throw new CancellationError(); output += chunk.delta; usage = chunk.usage ?? usage; yield chunk; }
      validateOutput(output, options.responseFormat ?? this.responseFormat);
      await this.emit({ type: 'model.completed', runId, data: { iteration: 1, usage, streaming: true } });
      await this.emit({ type: 'agent.completed', runId, data: { output, iterations: 1, usage, durationMs: Date.now() - started, streaming: true } });
    } catch (error) { await this.emit({ type: 'agent.failed', runId, data: { error: error instanceof Error ? error.message : String(error), streaming: true } }); throw error; }
  }

  private async generateWithRetries(request: ModelRequest, timeoutMs: number | undefined, signal: AbortSignal, runId: string, iteration: number): Promise<ModelResponse> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.modelRetries + 1; attempt += 1) {
      try { return await withTimeout(this.model.generate(request), timeoutMs, signal); }
      catch (error) { lastError = error; if (error instanceof CancellationError || signal.aborted || attempt > this.modelRetries) break; await this.emit({ type: 'model.requested', runId, data: { iteration, attempt: attempt + 1, retry: true, model: this.model.model, provider: this.model.provider } }); }
    }
    throw lastError;
  }

  private async executeTool(call: ToolCall, runId: string, signal: AbortSignal, options: AgentRunOptions, _history: ToolExecutionResult[]): Promise<ToolExecutionResult> {
    const tool = this.tools.find((candidate) => candidate.name === call.name); const started = Date.now();
    if (!tool) { const error = new AgentForgeError(`Unknown tool: ${call.name}`, 'UNKNOWN_TOOL'); return { id: call.id, name: call.name, input: call.arguments, error, durationMs: 0, attempts: 0 }; }
    await this.emit({ type: 'tool.started', runId, data: { tool: tool.name, callId: call.id, input: call.arguments } });
    const allowed = new Set(options.allowedToolPermissions ?? this.allowedToolPermissions); const missing = (tool.permissions ?? []).filter((permission) => !allowed.has(permission));
    if (missing.length) { const error = new PermissionDeniedError(tool.name, missing); await this.emit({ type: 'tool.failed', runId, data: { tool: tool.name, error: error.message, permissions: missing, attempts: 0 } }); return { id: call.id, name: call.name, input: call.arguments, error, durationMs: Date.now() - started, attempts: 0 }; }
    let attempts = 0; const retries = tool.retries ?? 0; let lastError: unknown;
    while (attempts <= retries) { attempts += 1; try {
      const parsed = tool.inputSchema.parse(call.arguments); const output = await withTimeout(tool.execute(parsed, { runId, signal, metadata: options.metadata }), tool.timeoutMs ?? options.timeoutMs, signal);
      const result = { id: call.id, name: call.name, input: parsed, output, durationMs: Date.now() - started, attempts }; await this.emit({ type: 'tool.completed', runId, data: { tool: call.name, durationMs: result.durationMs, attempts } }); return result;
    } catch (error) { lastError = error; if (attempts > retries) break; } }
    const error = lastError instanceof Error ? lastError : new Error(String(lastError)); const result = { id: call.id, name: call.name, input: call.arguments, error, durationMs: Date.now() - started, attempts }; await this.emit({ type: 'tool.failed', runId, data: { tool: call.name, error: error.message, attempts } }); return result;
  }
  private async emit(event: Omit<AgentEvent, 'timestamp'>): Promise<void> { await this.events.emit({ ...event, timestamp: new Date().toISOString() }); }
}

function schemaToJson(schema: z.ZodType<unknown>): Record<string, unknown> { return zodToJsonSchema(schema, { $refStrategy: 'none', target: 'openApi3' }) as Record<string, unknown>; }
function validateOutput(content: string, format?: ModelRequest['responseFormat']): void { if (format?.type !== 'json') return; let value: unknown; try { value = JSON.parse(content); } catch (cause) { throw new AgentForgeError('Model returned invalid JSON structured output', 'INVALID_MODEL_OUTPUT', cause); } format.schema?.parse(value); }
