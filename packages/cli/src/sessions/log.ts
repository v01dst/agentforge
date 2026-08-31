import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newSessionId, sessionsDir, type StoredSession, SESSION_SCHEMA_VERSION } from './store.js';

/**
 * NDJSON log-as-truth (Phase H): every conversation turn is appended to
 * `<sessionsDir>/<id>.ndjson` as one JSON line, in order, forever. The JSON
 * snapshot (`<id>.json`) is a derived, compacted view for fast loads and
 * listing; the log is the durable record — compaction never rewrites it and
 * forks replay from it.
 *
 * Line shape: one JSON object per line with `type` as the discriminator.
 * Corrupt trailing lines (crash mid-append) are skipped on read, never
 * discarded on write.
 */

export type SessionLogEntryType = 'user' | 'assistant' | 'system' | 'tool' | 'meta';

export interface SessionLogEntry {
  /** Milliseconds since epoch. */
  ts: number;
  type: SessionLogEntryType;
  text: string;
  /** Optional structured metadata (tool name, durations, ids). */
  meta?: Record<string, unknown>;
}

export function sessionLogPath(id: string, cwd = process.cwd(), global = false): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error(`Invalid session id: ${id}`);
  return join(sessionsDir(cwd, global), `${id}.ndjson`);
}

function serializeEntry(entry: SessionLogEntry): string {
  return JSON.stringify({
    ts: entry.ts,
    type: entry.type,
    text: entry.text,
    ...(entry.meta ? { meta: entry.meta } : {}),
  });
}

/** Append one event to a session's log, creating the file when missing. */
export async function appendSessionLog(
  id: string,
  entry: Omit<SessionLogEntry, 'ts'> & { ts?: number },
  cwd = process.cwd(),
  global = false,
): Promise<void> {
  await mkdir(sessionsDir(cwd, global), { recursive: true });
  const line = serializeEntry({ ...entry, ts: entry.ts ?? Date.now() });
  await appendFile(sessionLogPath(id, cwd, global), `${line}\n`, 'utf8');
}

export function parseSessionLog(raw: string): SessionLogEntry[] {
  const entries: SessionLogEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.ts !== 'number') continue;
      if (typeof parsed.type !== 'string') continue;
      if (typeof parsed.text !== 'string') continue;
      entries.push({
        ts: parsed.ts,
        type: parsed.type as SessionLogEntryType,
        text: parsed.text,
        ...(parsed.meta && typeof parsed.meta === 'object' ? { meta: parsed.meta as Record<string, unknown> } : {}),
      });
    } catch {
      continue;
    }
  }
  return entries;
}

/** Read and parse a session log; missing file yields an empty list. */
export async function readSessionLog(id: string, cwd = process.cwd(), global = false): Promise<SessionLogEntry[]> {
  try {
    return parseSessionLog(await readFile(sessionLogPath(id, cwd, global), 'utf8'));
  } catch {
    return [];
  }
}

/** Fold a parsed log into a session-like message list (oldest first). */
export function foldLogToMessages(entries: readonly SessionLogEntry[]): StoredSession['messages'] {
  return entries
    .filter((entry) => entry.type !== 'meta')
    .map((entry) => ({ role: entry.type as StoredSession['messages'][number]['role'], text: entry.text }));
}

/**
 * Rebuild the full (never-compacted) transcript from the log — the
 * log-as-truth counterpart of the compacted snapshot view.
 */
export async function loadFullTranscript(id: string, cwd = process.cwd(), global = false): Promise<StoredSession['messages']> {
  return foldLogToMessages(await readSessionLog(id, cwd, global));
}

export interface ForkOptions {
  cwd?: string;
  /** New session title; defaults to `<parent title> (fork)`. */
  title?: string;
  /**
   * Cut point: copy the first N messages (default: all). Out-of-range values
   * clamp; negative values fork from the end (last |n| messages).
   */
  upTo?: number;
  /** Force the fork into the global store instead of the parent's store. */
  global?: boolean;
}

export interface ForkResult {
  session: StoredSession;
  /** Id of the parent session. */
  from: string;
  /** Messages copied into the fork. */
  copied: number;
}

/**
 * Fork a session (Phase H): replay the parent's durable log (or snapshot when
 * no log exists) into a fresh session with a new id, up to the cut point.
 * The fork records its lineage in `forkedFrom` and carries full history —
 * compaction applied to the parent's snapshot never truncates a fork.
 */
export async function forkSession(id: string, options: ForkOptions = {}): Promise<ForkResult | undefined> {
  const cwd = options.cwd ?? process.cwd();
  const parent = await findParent(id, cwd);
  if (!parent) return undefined;

  const logEntries = await readSessionLog(parent.id, cwd, parent.global);
  const fullMessages: StoredSession['messages'] = logEntries.length
    ? foldLogToMessages(logEntries)
    : await (async () => {
      // Snapshot fallback: snapshot is compacted, so prepend the stored
      // summary as a system message to preserve context.
      const base = parent.session.messages;
      return parent.session.summary
        ? [{ role: 'system' as const, text: parent.session.summary }, ...base]
        : base;
    })();

  const cut = normalizeCut(options.upTo, fullMessages.length);
  const copiedMessages = fullMessages.slice(0, cut);

  const forkId = `${newSessionId()}-f`;
  const title = (options.title ?? `${parent.session.title} (fork)`).slice(0, 120);
  const now = new Date().toISOString();
  const fork: StoredSession = {
    id: forkId,
    title,
    createdAt: now,
    updatedAt: now,
    messages: copiedMessages,
    provider: parent.session.provider,
    model: parent.session.model,
    version: SESSION_SCHEMA_VERSION,
    summary: undefined,
    forkedFrom: parent.id,
  };

  const targetGlobal = options.global ?? parent.global;
  await writeFork(fork, copiedMessages, cwd, targetGlobal);
  return { session: fork, from: parent.id, copied: copiedMessages.length };
}

async function writeFork(fork: StoredSession, messages: StoredSession['messages'], cwd: string, global: boolean): Promise<void> {
  await mkdir(sessionsDir(cwd, global), { recursive: true });
  // Snapshot for fast loads.
  await writeFile(join(sessionsDir(cwd, global), `${fork.id}.json`), JSON.stringify(fork, null, 2), 'utf8');
  // Durable log replay: one line per copied message.
  if (messages.length) {
    await appendFile(
      sessionLogPath(fork.id, cwd, global),
      `${messages.map((message) => serializeEntry({ ts: Date.parse(fork.createdAt), type: message.role, text: message.text })).join('\n')}\n`,
      'utf8',
    );
  }
}

async function findParent(id: string, cwd: string): Promise<{ id: string; session: StoredSession; global: boolean } | undefined> {
  for (const global of [false, true]) {
    try {
      const raw = await readFile(join(sessionsDir(cwd, global), `${id}.json`), 'utf8');
      const parsed = JSON.parse(raw) as StoredSession;
      if (parsed?.id && Array.isArray(parsed.messages)) return { id: parsed.id, session: parsed, global };
    } catch {
      continue;
    }
  }
  return undefined;
}

function normalizeCut(upTo: number | undefined, total: number): number {
  if (upTo === undefined) return total;
  if (upTo < 0) return Math.max(0, total + upTo);
  return Math.min(total, Math.max(0, upTo));
}
