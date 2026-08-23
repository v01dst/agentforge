import type { AgentEvent, EventSink, Logger } from '@agentforge/core';
export * from '@agentforge/core';

export interface EventStore { append(event: AgentEvent): void | Promise<void>; list(runId?: string): AgentEvent[] | Promise<AgentEvent[]>; }
export class MemoryEventStore implements EventStore {
  readonly events: AgentEvent[] = [];
  append(event: AgentEvent): void { this.events.push(event); }
  list(runId?: string): AgentEvent[] { return runId ? this.events.filter((event) => event.runId === runId) : [...this.events]; }
}
export class EventStoreSink implements EventSink { constructor(private readonly store: EventStore) {} emit(event: AgentEvent): void | Promise<void> { return this.store.append(event); } }

const secretPatterns = [/(["']?(?:api[_-]?key|authorization|token|secret|password)["']?\s*[:=]\s*["']?)([^\s,"'}]+)/gi, /(sk-[A-Za-z0-9_-]{12,})/g, /(Bearer\s+)[A-Za-z0-9._~-]+/gi];
export function redactSecrets(value: unknown): unknown { if (typeof value === 'string') return secretPatterns.reduce((result, pattern) => result.replace(pattern, '$1[REDACTED]'), value); if (Array.isArray(value)) return value.map(redactSecrets); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /key|token|secret|password|authorization/i.test(key) ? '[REDACTED]' : redactSecrets(item)])); return value; }
export function redactEvent(event: AgentEvent): AgentEvent { return { ...event, data: redactSecrets(event.data) as Record<string, unknown> }; }

export class StructuredConsoleLogger implements Logger {
  constructor(private readonly options: { component?: string; sink?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'> } = {}) {}
  debug(message: string, data?: Record<string, unknown>): void { this.write('debug', message, data); }
  info(message: string, data?: Record<string, unknown>): void { this.write('info', message, data); }
  warn(message: string, data?: Record<string, unknown>): void { this.write('warn', message, data); }
  error(message: string, data?: Record<string, unknown>): void { this.write('error', message, data); }
  private write(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) { const payload = redactSecrets({ level, message, component: this.options.component, timestamp: new Date().toISOString(), ...data }); (this.options.sink ?? console)[level](JSON.stringify(payload)); }
}

export interface UsageRecord { runId: string; provider?: string; model?: string; inputTokens: number; outputTokens: number; estimatedCost?: number; timestamp: string; }
export function estimateCost(usage: { inputTokens: number; outputTokens: number }, rates: { inputPerMillion?: number; outputPerMillion?: number } = {}): number { return (usage.inputTokens / 1_000_000) * (rates.inputPerMillion ?? 0) + (usage.outputTokens / 1_000_000) * (rates.outputPerMillion ?? 0); }
