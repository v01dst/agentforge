import { z } from 'zod';
import type { AgentInterceptors } from './interceptors.js';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: Role;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ModelRequest {
  messages: Message[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ModelToolDefinition[];
  responseFormat?: { type: 'text' | 'json'; schema?: z.ZodType<unknown> };
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelResponse {
  id: string;
  content: string;
  toolCalls?: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  usage?: TokenUsage;
  model?: string;
  raw?: unknown;
}

export interface ModelChunk {
  id: string;
  delta: string;
  toolCall?: ToolCall;
  done?: boolean;
  usage?: TokenUsage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ModelProvider {
  readonly provider: string;
  readonly model?: string;
  generate(request: ModelRequest): Promise<ModelResponse>;
  stream?(request: ModelRequest): AsyncIterable<ModelChunk>;
}

export interface AgentRunOptions {
  signal?: AbortSignal;
  maxIterations?: number;
  timeoutMs?: number;
  allowedToolPermissions?: string[];
  responseFormat?: ModelRequest['responseFormat'];
  metadata?: Record<string, unknown>;
}

export interface AgentConfig {
  name: string;
  model: ModelProvider;
  instructions?: string;
  tools?: ToolLike[];
  maxIterations?: number;
  timeoutMs?: number;
  modelRetries?: number;
  allowedToolPermissions?: string[];
  responseFormat?: ModelRequest['responseFormat'];
  metadata?: Record<string, unknown>;
  /** Waterfall interceptors (Phase N): reflection, compression, guards, observability. */
  interceptors?: AgentInterceptors;
}

export interface AgentRunOptions {
  signal?: AbortSignal;
  maxIterations?: number;
  timeoutMs?: number;
  allowedToolPermissions?: string[];
  responseFormat?: ModelRequest['responseFormat'];
  metadata?: Record<string, unknown>;
}

export interface AgentResult {
  runId: string;
  output: string;
  messages: Message[];
  iterations: number;
  usage: TokenUsage;
  toolCalls: ToolExecutionResult[];
  durationMs: number;
}

export interface ToolLike {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly permissions?: string[];
  readonly timeoutMs?: number;
  readonly retries?: number;
  execute(input: unknown, context: ToolContext): Promise<unknown>;
}

export interface ToolContext {
  runId: string;
  signal: AbortSignal;
  logger?: Logger;
  metadata?: Record<string, unknown>;
}

export interface ToolExecutionResult {
  id: string;
  name: string;
  input: unknown;
  output?: unknown;
  error?: Error;
  durationMs: number;
  attempts: number;
}

export type AgentEventType =
  | 'agent.started' | 'agent.completed' | 'agent.failed'
  | 'model.requested' | 'model.completed'
  | 'tool.started' | 'tool.completed' | 'tool.failed'
  | 'workflow.started' | 'workflow.completed' | 'workflow.failed'
  | 'workflow.node.started' | 'workflow.node.completed' | 'workflow.node.failed';

export interface AgentEvent {
  type: AgentEventType;
  runId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface EventSink { emit(event: AgentEvent): void | Promise<void>; }
export interface Logger {
  debug?(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export class AgentForgeError extends Error {
  readonly code: string;
  override readonly cause?: unknown;
  constructor(message: string, code = 'AGENTFORGE_ERROR', cause?: unknown) {
    super(message); this.name = 'AgentForgeError'; this.code = code; this.cause = cause;
  }
}

export class CancellationError extends AgentForgeError { constructor(message = 'Operation cancelled') { super(message, 'CANCELLED'); this.name = 'CancellationError'; } }
export class MaxIterationsError extends AgentForgeError { constructor(max: number) { super(`Maximum agent iterations (${max}) exceeded`, 'MAX_ITERATIONS'); this.name = 'MaxIterationsError'; } }
export class ToolExecutionError extends AgentForgeError { constructor(tool: string, message: string, cause?: unknown) { super(`Tool ${tool} failed: ${message}`, 'TOOL_ERROR', cause); this.name = 'ToolExecutionError'; } }
export class PermissionDeniedError extends AgentForgeError { constructor(tool: string, permissions: string[]) { super(`Tool ${tool} requires permissions: ${permissions.join(', ')}`, 'PERMISSION_DENIED'); this.name = 'PermissionDeniedError'; } }

export function createRunId(prefix = 'run'): string { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`; }
export function emptyUsage(): TokenUsage { return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }; }
export function addUsage(a: TokenUsage, b?: TokenUsage): TokenUsage {
  if (!b) return a;
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, totalTokens: a.totalTokens + b.totalTokens };
}
