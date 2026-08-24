import type { ChatSession, RunnableModule, SessionTurn, SessionUsage, StreamableAgent } from '../types.js';

export interface TurnUsage {
  totalTokens?: number;
  estimatedCostUsd?: number;
}

export interface TurnDelta {
  text?: string;
  usage?: TurnUsage;
  runId?: string;
}

export type SkillSelection = readonly string[];

export type TurnRunner = (input: string, signal: AbortSignal, context: { skills: SkillSelection }) => AsyncIterable<TurnDelta>;

/** Extract human-readable text from any runnable result shape. */
export function resultText(result: unknown): string {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'number' || typeof result === 'boolean') return String(result);
  if (result instanceof Error) return `Error: ${result.message}`;
  const record = result as Record<string, unknown>;
  if ('output' in record && record.output !== undefined) return resultText(record.output);
  if (typeof record.content === 'string') return record.content;
  return JSON.stringify(result, null, 2);
}

async function* streamFromAgent(agent: StreamableAgent, input: string, signal: AbortSignal): AsyncIterable<TurnDelta> {
  if (typeof agent.stream !== 'function') {
    const result = await agent.run(input, { signal });
    const record = result as Record<string, unknown> | null | undefined;
    if (record && typeof record === 'object' && typeof record.runId === 'string') yield { runId: record.runId };
    yield { text: resultText(result) };
    return;
  }
  let usage: TurnUsage | undefined;
  for await (const chunk of agent.stream(input, { signal })) {
    if (chunk && typeof chunk === 'object' && typeof chunk.delta === 'string' && chunk.delta) yield { text: chunk.delta };
    if (chunk && typeof chunk === 'object' && chunk.usage) usage = chunk.usage;
  }
  if (usage) yield { usage };
}

/** Resolve the callable entry of a module, mirroring historical behavior. */
export function resolveRunnable(module: RunnableModule): (input: string, options?: Record<string, unknown>) => Promise<unknown> {
  if (typeof module.run === 'function') return (input, options) => Promise.resolve(module.run?.(input, options));
  if (typeof module.default === 'function') return (input) => Promise.resolve((module.default as (value: string) => unknown)(input));
  if (module.agent && typeof module.agent.run === 'function') return (input, options) => Promise.resolve(module.agent?.run(input, options));
  if (module.workflow && typeof module.workflow.run === 'function') return (input) => Promise.resolve(module.workflow?.run(input));
  if (module.default && typeof module.default === 'object' && 'run' in module.default && typeof (module.default as { run?: unknown }).run === 'function') {
    return (input, options) => Promise.resolve((module.default as { run: (value: string, options?: Record<string, unknown>) => unknown }).run(input, options));
  }
  throw new Error('Entrypoint must export run(), a default runnable, createAgent(), agent.run(), or workflow.run().');
}

function turnUsage(usage: SessionUsage | undefined): TurnUsage | undefined {
  if (!usage) return undefined;
  const total = usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
  return total > 0 ? { totalTokens: total } : undefined;
}

/** Yield one session turn as TurnDeltas, streaming when the session streams. */
async function* streamFromSession(session: ChatSession, input: string, signal: AbortSignal): AsyncIterable<TurnDelta> {
  const turn = await session.send(input, { signal });
  if (turn.runId) yield { runId: turn.runId };
  if (!turn.stream) {
    if (turn.text) yield { text: turn.text };
    const usage = turnUsage(turn.usage);
    if (usage) yield { usage };
    return;
  }
  let text = '';
  for await (const item of turn.stream) {
    if (signal.aborted) break;
    const delta = typeof item === 'string' ? item : item.delta;
    if (delta) {
      text += delta;
      yield { text: delta };
    }
    if (typeof item === 'object') {
      const chunkUsage = turnUsage(item.usage);
      if (chunkUsage) yield { usage: chunkUsage };
      if (!turn.runId && typeof item.runId === 'string') yield { runId: item.runId };
    }
  }
  if (!text && turn.text) yield { text: turn.text };
  const finalUsage = turnUsage(turn.usage);
  if (finalUsage) yield { usage: finalUsage };
}

/**
 * Build a streaming-capable turn runner from a project module.
 * Prefers `createSession` for real multi-turn context, then agent factories
 * (`createAgent`/`getAgent`) or an `agent` export so turns stream
 * token-by-token; falls back to one-shot `run()`.
 */
export function buildTurnRunner(module: RunnableModule): TurnRunner {
  let session: ChatSession | undefined;
  return async function* runTurn(input, signal, context) {
    if (!session && typeof module.createSession === 'function') {
      const created = await module.createSession.call(module);
      if (!created || typeof (created as ChatSession).send !== 'function') {
        throw new Error('createSession() must return an object with a send(input, options) method.');
      }
      session = created as ChatSession;
    }
    if (session) {
      yield* streamFromSession(session, prependSkills(input, context.skills), signal);
      return;
    }
    const factory = module.createAgent ?? module.getAgent;
    if (factory) {
      const agent = await factory();
      yield* streamFromAgent(agent, prependSkills(input, context.skills), signal);
      return;
    }
    if (module.agent && typeof module.agent.run === 'function') {
      yield* streamFromAgent(module.agent, prependSkills(input, context.skills), signal);
      return;
    }
    const runnable = resolveRunnable(module);
    const result = await runnable(prependSkills(input, context.skills), { signal });
    const record = result as Record<string, unknown> | null | undefined;
    if (record && typeof record === 'object' && typeof record.runId === 'string') yield { runId: record.runId };
    yield { text: resultText(result) };
  };
}

export function prependSkills(input: string, skills: SkillSelection): string {
  if (!skills.length) return input;
  const preamble = skills.map((body) => `[skill active]\n${body}`).join('\n\n');
  return `${preamble}\n\n${input}`;
}

export function parseSlashCommand(raw: string): { name: string; args: string[] } | undefined {
  if (!raw.startsWith('/')) return undefined;
  const parts = raw.slice(1).split(/\s+/).filter(Boolean);
  const name = parts[0];
  if (!name) return undefined;
  return { name: name.toLowerCase(), args: parts.slice(1) };
}
