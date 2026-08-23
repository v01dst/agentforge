import type { AgentEvent, EventSink, Logger } from './types.js';

export class EventBus {
  private readonly sinks = new Set<EventSink>();
  addSink(sink: EventSink): () => void { this.sinks.add(sink); return () => this.sinks.delete(sink); }
  async emit(event: AgentEvent): Promise<void> { await Promise.all([...this.sinks].map((sink) => sink.emit(event))); }
}

export class ConsoleLogger implements Logger {
  constructor(private readonly prefix = 'agentforge') {}
  debug(message: string, data?: Record<string, unknown>) { console.debug(`[${this.prefix}] ${message}`, data ?? ''); }
  info(message: string, data?: Record<string, unknown>) { console.info(`[${this.prefix}] ${message}`, data ?? ''); }
  warn(message: string, data?: Record<string, unknown>) { console.warn(`[${this.prefix}] ${message}`, data ?? ''); }
  error(message: string, data?: Record<string, unknown>) { console.error(`[${this.prefix}] ${message}`, data ?? ''); }
}
