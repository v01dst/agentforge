import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

/** One persisted conversation: transcript plus minimal metadata. */
export interface StoredSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Transcript lines, oldest first ("role › text" style is render-agnostic). */
  messages: Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; text: string }>;
  provider?: string;
  model?: string;
  /** Schema version for forward compatibility; older files are treated as 1. */
  version?: 1;
  /** Rolling summary of turns removed by compaction (see compactTranscript). */
  summary?: string;
  /** Set when this session was created by forking another (Phase H). */
  forkedFrom?: string;
}

export const SESSION_SCHEMA_VERSION = 1 as const;

export function sessionsDir(cwd = process.cwd(), global = false): string {
  return global ? join(homedir(), '.agentforge', 'sessions') : join(resolve(cwd), '.agentforge', 'sessions');
}

function sessionPath(id: string, cwd = process.cwd(), global = false): string {
  // Ids are generated here; sanitize defensively anyway.
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error(`Invalid session id: ${id}`);
  return join(sessionsDir(cwd, global), `${id}.json`);
}

export function newSessionId(now = Date.now()): string {
  return `s-${now.toString(36)}-${randomBytes(3).toString('hex')}`;
}

export async function saveSession(session: StoredSession, cwd = process.cwd(), global = false): Promise<string> {
  const dir = sessionsDir(cwd, global);
  await mkdir(dir, { recursive: true });
  const path = sessionPath(session.id, cwd, global);
  await writeFile(path, JSON.stringify(session, null, 2));
  return path;
}

export async function loadSession(id: string, cwd = process.cwd(), global = false): Promise<StoredSession | undefined> {
  try {
    return JSON.parse(await readFile(sessionPath(id, cwd, global), 'utf8')) as StoredSession;
  } catch {
    return undefined;
  }
}

/** Locate a session in the project store first, then global; remembers where. */
export async function locateSession(id: string, cwd = process.cwd()): Promise<{ session: StoredSession; global: boolean } | undefined> {
  for (const global of [false, true]) {
    const stored = await loadSession(id, cwd, global);
    if (stored) return { session: stored, global };
  }
  return undefined;
}

/** Rename a session in whichever store holds it; returns false when unknown. */
export async function renameSession(id: string, title: string, cwd = process.cwd()): Promise<boolean> {
  const found = await locateSession(id, cwd);
  if (!found) return false;
  const trimmed = title.trim();
  if (!trimmed) throw new Error('Session title cannot be empty.');
  found.session.title = trimmed.slice(0, 120);
  found.session.updatedAt = new Date().toISOString();
  found.session.version = SESSION_SCHEMA_VERSION;
  await saveSession(found.session, cwd, found.global);
  return true;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  messages: number;
}

/** List summaries from both project and global stores (project wins on id clash). */
export async function listSessions(cwd = process.cwd()): Promise<SessionSummary[]> {
  const summaries = new Map<string, SessionSummary>();
  for (const global of [true, false]) {
    let files: string[];
    try {
      files = (await readdir(sessionsDir(cwd, global))).filter((file) => file.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const parsed = JSON.parse(await readFile(join(sessionsDir(cwd, global), file), 'utf8')) as StoredSession;
        if (!parsed?.id || !Array.isArray(parsed.messages)) continue;
        summaries.set(parsed.id, { id: parsed.id, title: parsed.title, updatedAt: parsed.updatedAt, messages: parsed.messages.length });
      } catch {
        continue;
      }
    }
  }
  return [...summaries.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function deleteSession(id: string, cwd = process.cwd(), global = false): Promise<boolean> {
  try {
    await unlink(sessionPath(id, cwd, global));
    return true;
  } catch {
    return false;
  }
}

/** Delete a session from both stores without caring where it lives. */
async function deleteEverywhere(id: string, cwd = process.cwd()): Promise<void> {
  await deleteSession(id, cwd, false);
  await deleteSession(id, cwd, true);
}

export interface PruneOptions {
  cwd?: string;
  /** Delete sessions not updated within this many days. */
  olderThanDays?: number;
  /** After age pruning, keep only the newest N sessions. */
  keep?: number;
  /** Report what would be removed without deleting. */
  dryRun?: boolean;
}

/**
 * Retention control: remove sessions by age and/or keep only the newest N.
 * Ids are removed from both stores. Returns the removed session ids.
 */
export async function pruneSessions(options: PruneOptions = {}): Promise<string[]> {
  const cwd = options.cwd ?? process.cwd();
  const all = await listSessions(cwd);
  const cutoff = options.olderThanDays !== undefined
    ? Date.now() - options.olderThanDays * 24 * 60 * 60 * 1000
    : undefined;
  const doomed = new Set<string>();
  if (cutoff !== undefined) {
    for (const entry of all) {
      if (Date.parse(entry.updatedAt) < cutoff) doomed.add(entry.id);
    }
  }
  if (options.keep !== undefined) {
    const survivors = all.filter((entry) => !doomed.has(entry.id)).slice(options.keep);
    for (const entry of survivors) doomed.add(entry.id);
  }
  if (!options.dryRun) {
    for (const id of doomed) await deleteEverywhere(id, cwd);
  }
  return [...doomed];
}

export interface TranscriptCompaction {
  /** Messages to keep (recent tail). */
  messages: StoredSession['messages'];
  /** Human-readable summary of the removed older turns, or undefined when nothing was compacted. */
  summary?: string;
}

export const COMPACT_THRESHOLD_MESSAGES = 40;
export const COMPACT_KEEP_RECENT = 20;
const SUMMARY_ENTRY_LIMIT = 40;
const SUMMARY_TEXT_LIMIT = 120;

/**
 * Pure compaction policy: when a transcript grows past
 * COMPACT_THRESHOLD_MESSAGES, roll everything but the most recent
 * COMPACT_KEEP_RECENT entries into a bounded summary string.
 */
export function compactTranscript(
  messages: StoredSession['messages'],
  options: { threshold?: number; keepRecent?: number } = {},
): TranscriptCompaction {
  const threshold = options.threshold ?? COMPACT_THRESHOLD_MESSAGES;
  const keepRecent = options.keepRecent ?? COMPACT_KEEP_RECENT;
  if (messages.length <= threshold) return { messages };
  const older = messages.slice(0, messages.length - keepRecent);
  const summaryEntries = older
    .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
    .slice(-SUMMARY_ENTRY_LIMIT)
    .map((entry) => `${entry.role}: ${entry.text.length > SUMMARY_TEXT_LIMIT ? `${entry.text.slice(0, SUMMARY_TEXT_LIMIT)}…` : entry.text}`);
  const summary = summaryEntries.length ? `[earlier conversation]\n${summaryEntries.join('\n')}` : undefined;
  return { messages: messages.slice(messages.length - keepRecent), summary };
}
