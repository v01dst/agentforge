export interface NamedEntry {
  name: string;
  description?: string;
  [key: string]: unknown;
}

export interface AgentForgeConfig {
  name?: string;
  entry?: string;
  providers?: readonly (string | NamedEntry)[];
  /** Optional custom provider module or provider name used by project tooling. */
  provider?: string;
  model?: string;
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

export interface RunnableModule {
  run?: (input: string, options?: Record<string, unknown>) => Promise<unknown> | unknown;
  default?: unknown;
  agent?: { run: (input: string, options?: Record<string, unknown>) => Promise<unknown> | unknown };
  workflow?: { run: (input: unknown, options?: Record<string, unknown>) => Promise<unknown> | unknown };
}

export interface ParsedCli {
  command?: string;
  args: string[];
  flags: Record<string, string | boolean>;
}
