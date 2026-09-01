import type { ChatSession, NamedEntry, RunnableModule, SessionTurn, StreamChunk, SessionUsage } from './types.js';
import { resolveRunnable, resultText } from './ui/turn.js';
import { COMPACT_KEEP_RECENT, COMPACT_THRESHOLD_MESSAGES } from './sessions/store.js';

export { resolveRunnable };

export function isAsyncIterable(value: unknown): value is AsyncIterable<string | StreamChunk> {
  return Boolean(value) && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
}

export function isCancelLike(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: string; message?: string; code?: string };
  return candidate.name === 'AbortError'
    || candidate.name === 'CancellationError'
    || candidate.code === 'CANCELLED'
    || /cancel|abort/i.test(candidate.message ?? '');
}

function coerceUsage(value: unknown): SessionUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const usage = value as SessionUsage;
  if (typeof usage.inputTokens !== 'number' && typeof usage.outputTokens !== 'number' && typeof usage.totalTokens !== 'number') return undefined;
  return usage;
}

/**
 * Wrap a one-shot runnable as a session by replaying the transcript as a
 * single prompt. Context continuity is best-effort and model-dependent.
 * Long transcripts are compacted: older turns roll into a bounded summary
 * block so prompts stay bounded across extended sessions.
 */
export function transcriptSession(run: (input: string, options?: Record<string, unknown>) => Promise<unknown>): ChatSession {
  const transcript: string[] = [];
  let carriedSummary: string | undefined;
  const compact = (): string[] => {
    if (transcript.length <= COMPACT_THRESHOLD_MESSAGES) return transcript;
    const older = transcript.slice(0, transcript.length - COMPACT_KEEP_RECENT);
    const summaryLines = older.slice(-40).map((line) => (line.length > 120 ? `${line.slice(0, 120)}…` : line));
    carriedSummary = [carriedSummary, '[earlier conversation]', ...summaryLines].filter(Boolean).join('\n');
    return transcript.slice(transcript.length - COMPACT_KEEP_RECENT);
  };
  return {
    async send(input: string, options?: { signal?: AbortSignal }): Promise<SessionTurn> {
      transcript.push(`User: ${input}`);
      const started = Date.now();
      const prompt = [
        ...(carriedSummary ? [carriedSummary, ''] : []),
        ...compact(),
        'Assistant:',
      ].join('\n');
      const result = (await run(prompt, options)) as { output?: unknown; runId?: unknown; usage?: unknown; durationMs?: unknown; provider?: unknown; model?: unknown } | null;
      const record = result && typeof result === 'object' ? result : {};
      const text = record.output !== undefined ? resultText({ output: record.output }) : '';
      transcript.push(`Assistant: ${text}`);
      return {
        text,
        runId: typeof record.runId === 'string' ? record.runId : undefined,
        usage: coerceUsage(record.usage),
        durationMs: typeof record.durationMs === 'number' ? record.durationMs : Date.now() - started,
        meta: {
          provider: typeof record.provider === 'string' ? record.provider : undefined,
          model: typeof record.model === 'string' ? record.model : undefined,
        },
      };
    },
  };
}

/** Adapt any supported entrypoint module into a ChatSession. */
export async function createSessionFromModule(module: RunnableModule): Promise<ChatSession> {
  const factory = module.createSession;
  if (typeof factory === 'function') {
    const session = await factory.call(module);
    if (!session || typeof (session as ChatSession).send !== 'function') {
      throw new Error('createSession() must return an object with a send(input, options) method.');
    }
    return session as ChatSession;
  }
  return transcriptSession(resolveRunnable(module));
}

export interface DrainResult {
  text: string;
  usage?: SessionUsage;
  runId?: string;
  meta?: Record<string, unknown>;
  cancelled: boolean;
}

/** Consume a turn stream, forwarding deltas to `onDelta` as they arrive. */
export async function drainStream(
  stream: AsyncIterable<string | StreamChunk>,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<DrainResult> {
  let text = '';
  let usage: SessionUsage | undefined;
  let runId: string | undefined;
  let meta: Record<string, unknown> | undefined;
  let cancelled = false;
  try {
    for await (const item of stream) {
      if (signal?.aborted) { cancelled = true; break; }
      if (typeof item === 'string') { text += item; onDelta(item); continue; }
      if (item.delta) { text += item.delta; onDelta(item.delta); }
      if (item.usage) usage = item.usage;
      if (item.runId) runId = item.runId;
      if (item.meta) meta = { ...meta, ...item.meta };
      if (item.done) break;
    }
  } catch (caught) {
    if (!isCancelLike(caught)) throw caught;
    cancelled = true;
  }
  return { text, usage, runId, meta, cancelled };
}

/** Compact single-line summary rendered under each assistant reply. */
export function formatTurnFooter(turn: {
  runId?: string;
  usage?: SessionUsage;
  durationMs?: number;
  meta?: Record<string, unknown>;
}): string | undefined {
  const bits: string[] = [];
  if (turn.runId) bits.push(`run ${turn.runId}`);
  const provider = typeof turn.meta?.provider === 'string' ? turn.meta.provider : undefined;
  const model = typeof turn.meta?.model === 'string' ? turn.meta.model : undefined;
  if (provider || model) bits.push([provider, model].filter(Boolean).join('/'));
  if (typeof turn.durationMs === 'number') bits.push(`${Math.round(turn.durationMs)}ms`);
  const usage = turn.usage;
  if (usage && (usage.totalTokens ?? 0) > 0) {
    bits.push(`tokens in ${usage.inputTokens ?? '?'} out ${usage.outputTokens ?? '?'}`);
  }
  return bits.length ? `[${bits.join(' · ')}]` : undefined;
}

export interface ModelInfoRow {
  provider: string;
  description: string;
  defaultModel?: string;
  envVars: readonly string[];
  ready: boolean | null;
  source: 'builtin' | 'config';
  protocol?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
}

const BUILTIN_MODELS: ReadonlyArray<Omit<ModelInfoRow, 'ready' | 'source'>> = [
  { provider: 'openai', description: 'OpenAI chat completions', defaultModel: 'gpt-4o-mini', envVars: ['OPENAI_API_KEY'] },
  { provider: 'anthropic', description: 'Anthropic Messages API', defaultModel: 'claude-3-5-sonnet-latest', envVars: ['ANTHROPIC_API_KEY'] },
  { provider: 'google', description: 'Google Gemini', defaultModel: 'gemini-1.5-flash', envVars: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'] },
];

const PROVIDER_ENV_HINTS: Record<string, readonly string[]> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  gemini: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
};

function isDefinition(entry: NamedEntry): boolean {
  return typeof entry.protocol === 'string';
}

/** Build the report shown by `agentforge models list` (pure, testable). */
export function buildModelReport(configEntries: readonly (string | NamedEntry)[] = [], env: NodeJS.ProcessEnv = process.env): ModelInfoRow[] {
  const rows: ModelInfoRow[] = BUILTIN_MODELS.map((row) => ({
    ...row,
    ready: row.envVars.length === 0 ? true : row.envVars.some((name) => Boolean(env[name])),
    source: 'builtin',
  }));
  const knownNames = new Set(BUILTIN_MODELS.map((row) => row.provider));
  const plainConfigured = new Set<string>();
  for (const entry of configEntries) {
    if (typeof entry === 'string') { plainConfigured.add(entry); continue; }
    if (!isDefinition(entry)) continue;
    const name = entry.name;
    const protocol = String(entry.protocol);
    const apiKeyEnv = typeof entry.apiKeyEnv === 'string' ? entry.apiKeyEnv : undefined;
    const baseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl : undefined;
    const model = typeof entry.model === 'string' ? entry.model : undefined;
    const ready = protocol === 'openai-compatible'
      ? Boolean(baseUrl) && (!apiKeyEnv || Boolean(env[apiKeyEnv]))
      : apiKeyEnv ? Boolean(env[apiKeyEnv]) : null;
    rows.push({
      provider: name,
      description: entry.description ?? `${protocol} endpoint`,
      defaultModel: model,
      envVars: apiKeyEnv ? [apiKeyEnv] : [],
      ready,
      source: 'config',
      protocol,
      baseUrl,
      apiKeyEnv,
    });
  }
  for (const entry of configEntries) {
    const name = typeof entry === 'string' ? entry : isDefinition(entry) ? '' : entry.name;
    if (!name || knownNames.has(name) || plainConfigured.has(name)) continue;
    if (typeof entry !== 'string' && isDefinition(entry)) continue;
    plainConfigured.add(name);
    const hintEnvs = PROVIDER_ENV_HINTS[name];
    rows.push({
      provider: name,
      description: typeof entry === 'string' ? 'Configured in agentforge.config.ts' : entry.description ?? 'Configured in agentforge.config.ts',
      envVars: hintEnvs ?? [],
      ready: hintEnvs ? hintEnvs.some((variable) => Boolean(env[variable])) : null,
      source: 'config',
    });
  }
  return rows;
}
