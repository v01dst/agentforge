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
}

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
