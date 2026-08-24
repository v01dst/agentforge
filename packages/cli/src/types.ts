export interface NamedEntry {
  name: string;
  description?: string;
  [key: string]: unknown;
}

/** Provider selection understood by the `@agentforge-oss/models` adapters. */
export interface ModelSelection {
  provider: 'openai' | 'anthropic' | 'google' | 'gemini' | 'mock' | string;
  model?: string;
  baseUrl?: string;
}

export interface AgentForgeConfig {
  name?: string;
  entry?: string;
  providers?: readonly (string | NamedEntry)[];
  /** Optional custom provider module or provider name used by project tooling. */
  provider?: string;
  /** Preferred model for interactive sessions, e.g. `'gpt-4o-mini'` or `{ provider, model }`. */
  model?: string | ModelSelection;
  tools?: readonly (string | NamedEntry)[];
  workflows?: readonly (string | NamedEntry)[];
  dev?: {
    command?: string | readonly string[];
    env?: Record<string, string>;
  };
  storage?: {
    getRun?: (runId: string) => Promise<unknown> | unknown;
  };
  inspectRun?: (runId: string) => Promise<unknown> | unknown;
  runtime?: { maxIterations?: number; timeoutMs?: number };
}

export interface RunnableResult {
  output?: unknown;
  [key: string]: unknown;
}

/** Minimal structural view of a core Agent (or compatible) used by chat. */
export interface StreamableAgent {
  run: (input: string, options?: Record<string, unknown>) => Promise<unknown>;
  stream?: (input: string, options?: Record<string, unknown>) => AsyncIterable<{
    delta?: unknown;
    usage?: {
      totalTokens?: number;
      estimatedCostUsd?: number;
    };
    [key: string]: unknown;
  }>;
}

export type AgentFactory = () => Promise<StreamableAgent>;

export interface SessionUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** Incremental stream item yielded by a streaming session turn. */
export interface StreamChunk {
  delta?: string;
  done?: boolean;
  runId?: string;
  usage?: SessionUsage;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * A single conversational turn. When `stream` is provided consumers must
 * drain it; `text`, `usage`, and `meta` are finalized once the stream ends.
 * Without `stream`, all fields are final when the promise resolves.
 */
export interface SessionTurn {
  text: string;
  runId?: string;
  usage?: SessionUsage;
  durationMs?: number;
  meta?: Record<string, unknown>;
  stream?: AsyncIterable<string | StreamChunk>;
}

/** Multi-turn conversation with preserved context. */
export interface ChatSession {
  send(input: string, options?: { signal?: AbortSignal }): Promise<SessionTurn>;
  reset?(): void | Promise<void>;
  close?(): void | Promise<void>;
}

export type SessionFactory = (options?: Record<string, unknown>) => ChatSession | Promise<ChatSession> | unknown;

export interface RunnableModule {
  run?: (input: string, options?: Record<string, unknown>) => Promise<unknown> | unknown;
  default?: unknown;
  /** Factory exported by scaffolded projects; preferred for streaming chat. */
  createAgent?: AgentFactory;
  getAgent?: AgentFactory;
  /** Stateful multi-turn session factory; preferred over one-shot exports. */
  createSession?: SessionFactory;
  agent?: StreamableAgent;
  workflow?: {
    run: (input: unknown, options?: Record<string, unknown>) => Promise<unknown> | unknown;
  };
}

export interface ParsedCli {
  command?: string;
  args: string[];
  flags: Record<string, string | boolean>;
}
