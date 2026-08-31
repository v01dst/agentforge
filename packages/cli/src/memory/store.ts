import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Which memory store an operation targets. */
export type MemoryTarget = 'memory' | 'user';

/** One memory entry: a single `§`-separated record on disk. */
export interface MemoryEntry {
  text: string;
}

export interface MemorySnapshot {
  target: MemoryTarget;
  entries: string[];
  /** Total characters across entries + separators. */
  used: number;
  limit: number;
  /** Fraction 0..1 of capacity in use. */
  ratio: number;
}

/** Character limits (~800 / ~500 tokens). Kept as Hermes-proven bounds. */
export const MEMORY_CHAR_LIMIT = 2200;
export const USER_CHAR_LIMIT = 1375;

const MEMORY_FILE = 'MEMORY.md';
const USER_FILE = 'USER.md';

/** Where memories live for a project (.agentforge/memories) and globally. */
export function memoriesDir(cwd = process.cwd(), global = false): string {
  return global
    ? join(homedir(), '.agentforge', 'memories')
    : join(resolve(cwd), '.agentforge', 'memories');
}

function fileFor(target: MemoryTarget, cwd: string, global: boolean): string {
  return join(memoriesDir(cwd, global), target === 'user' ? USER_FILE : MEMORY_FILE);
}

function limitFor(target: MemoryTarget): number {
  return target === 'user' ? USER_CHAR_LIMIT : MEMORY_CHAR_LIMIT;
}

/** Entries are separated by `§` markers; parse back into a list. */
export function parseMemoryDocument(raw: string): string[] {
  return raw
    .split('§')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function serialize(entries: string[]): string {
  return entries.join('\n§\n');
}

/** Render the frozen system-prompt snapshot block for a target. */
export function renderSnapshot(target: MemoryTarget, entries: string[]): string {
  const limit = limitFor(target);
  const used = entries.reduce((sum, entry) => sum + entry.length, 0) + Math.max(0, entries.length - 1) * 3;
  const label = target === 'user' ? 'USER PROFILE' : 'MEMORY (your personal notes)';
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
  const header = `${label} [${pct}% — ${used}/${limit} chars]`;
  if (!entries.length) return header;
  return [`${'═'.repeat(header.length)}`, header, `${'═'.repeat(header.length)}`, entries.join('§')].join('\n');
}

/** Load entries for a target: preferred scope, falling back to the other. */
export async function loadMemory(target: MemoryTarget, cwd = process.cwd(), global = false): Promise<MemorySnapshot> {
  let entries: string[] = [];
  // Preferred scope first (global when asked, project otherwise); the other
  // scope is the fallback. First file that exists wins.
  const scopes: boolean[] = global ? [true, false] : [false, true];
  for (const scope of scopes) {
    try {
      const raw = await readFile(fileFor(target, cwd, scope), 'utf8');
      entries = parseMemoryDocument(raw);
      break;
    } catch {
      continue;
    }
  }
  const used = entries.reduce((sum, entry) => sum + entry.length, 0) + Math.max(0, entries.length - 1) * 3;
  const limit = limitFor(target);
  return { target, entries, used, limit, ratio: limit > 0 ? used / limit : 0 };
}

function usedChars(entries: string[]): number {
  return entries.reduce((sum, entry) => sum + entry.length, 0) + Math.max(0, entries.length - 1) * 3;
}

export interface MemoryWriteResult {
  ok: boolean;
  message: string;
  snapshot: MemorySnapshot;
}

async function writeEntries(target: MemoryTarget, entries: string[], cwd: string, global: boolean): Promise<void> {
  const path = fileFor(target, cwd, global);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialize(entries), 'utf8');
}

/**
 * Single-scope read for write paths: reads ONLY the file this scope owns, so
 * a project write never silently absorbs (and copies) global content.
 */
async function loadMemoryScope(target: MemoryTarget, cwd: string, global: boolean): Promise<MemorySnapshot> {
  let entries: string[] = [];
  try {
    entries = parseMemoryDocument(await readFile(fileFor(target, cwd, global), 'utf8'));
  } catch {
    entries = [];
  }
  const limit = limitFor(target);
  const used = entries.reduce((sum, entry) => sum + entry.length, 0) + Math.max(0, entries.length - 1) * 3;
  return { target, entries, used, limit, ratio: limit > 0 ? used / limit : 0 };
}

/** Reject exact duplicates (case/space-insensitive comparison). */
function findDuplicate(entries: string[], candidate: string): string | undefined {
  const norm = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
  return entries.find((entry) => norm(entry) === norm(candidate));
}

export interface AddOptions {
  cwd?: string;
  global?: boolean;
  /** Injected capacity: char limit per target. */
  limits?: Partial<Record<MemoryTarget, number>>;
}

/** Add an entry, enforcing capacity and duplicate rules. */
export async function addMemoryEntry(target: MemoryTarget, text: string, options: AddOptions = {}): Promise<MemoryWriteResult> {
  const cwd = options.cwd ?? process.cwd();
  const global = options.global ?? false;
  const trimmed = text.trim();
  const snapshot = await loadMemoryScope(target, cwd, global);
  if (!trimmed) {
    return { ok: false, message: 'Memory entry cannot be empty.', snapshot };
  }
  const limit = options.limits?.[target] ?? limitFor(target);
  const duplicate = findDuplicate(snapshot.entries, trimmed);
  if (duplicate !== undefined) {
    return { ok: false, message: 'No duplicate added — an identical entry already exists.', snapshot };
  }
  const candidate = [...snapshot.entries, trimmed];
  const projected = usedChars(candidate);
  if (projected > limit) {
    return {
      ok: false,
      message: [
        `Memory at ${usedChars(snapshot.entries)}/${limit} chars. Adding this entry (${trimmed.length} chars) would exceed the limit.`,
        'Consolidate now: use replace to merge overlapping entries into shorter ones or remove stale entries (see current entries), then retry this add.',
      ].join(' '),
      snapshot,
    };
  }
  await writeEntries(target, candidate, cwd, global);
  const next = await loadMemoryScope(target, cwd, global);
  return { ok: true, message: `Entry added. ${next.used}/${next.limit} chars.`, snapshot: next };
}

export interface ReplaceOptions extends AddOptions {}

/** Replace the entry containing a unique substring. */
export async function replaceMemoryEntry(target: MemoryTarget, oldText: string, text: string, options: ReplaceOptions = {}): Promise<MemoryWriteResult> {
  const cwd = options.cwd ?? process.cwd();
  const global = options.global ?? false;
  const snapshot = await loadMemoryScope(target, cwd, global);
  const limit = options.limits?.[target] ?? limitFor(target);
  const needle = oldText.trim();
  if (!needle) return { ok: false, message: 'old_text is required to identify the entry to replace.', snapshot };
  const matches = snapshot.entries.filter((entry) => entry.includes(needle));
  if (matches.length === 0) return { ok: false, message: `No entry contains '${needle}'.`, snapshot };
  if (matches.length > 1) {
    return { ok: false, message: `'${needle}' matches ${matches.length} entries; provide a more unique substring.`, snapshot };
  }
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, message: 'Replacement text cannot be empty (use remove instead).', snapshot };
  const nextEntries = snapshot.entries.map((entry) => (entry.includes(needle) ? trimmed : entry));
  const projected = usedChars(nextEntries);
  if (projected > limit) {
    return {
      ok: false,
      message: `Replacement would put memory at ${projected}/${limit} chars. Shorten the new content or remove another entry first.`,
      snapshot,
    };
  }
  await writeEntries(target, nextEntries, cwd, global);
  const next = await loadMemoryScope(target, cwd, global);
  return { ok: true, message: `Entry replaced. ${next.used}/${next.limit} chars.`, snapshot: next };
}

/** Remove the entry containing a unique substring. */
export async function removeMemoryEntry(target: MemoryTarget, oldText: string, options: ReplaceOptions = {}): Promise<MemoryWriteResult> {
  const cwd = options.cwd ?? process.cwd();
  const global = options.global ?? false;
  const snapshot = await loadMemoryScope(target, cwd, global);
  const needle = oldText.trim();
  if (!needle) return { ok: false, message: 'old_text is required to identify the entry to remove.', snapshot };
  const matches = snapshot.entries.filter((entry) => entry.includes(needle));
  if (matches.length === 0) return { ok: false, message: `No entry contains '${needle}'.`, snapshot };
  if (matches.length > 1) {
    return { ok: false, message: `'${needle}' matches ${matches.length} entries; provide a more unique substring.`, snapshot };
  }
  const nextEntries = snapshot.entries.filter((entry) => !entry.includes(needle));
  await writeEntries(target, nextEntries, cwd, global);
  const next = await loadMemoryScope(target, cwd, global);
  return { ok: true, message: `Entry removed. ${next.used}/${next.limit} chars.`, snapshot: next };
}

/**
 * Persona sources injected into session instructions.
 * SOUL.md is the user's persona statement; AGENTS.md carries project conventions.
 */
export interface PersonaSources {
  soul?: string;
  agents?: string;
}

/** Read .agentforge/SOUL.md and AGENTS.md (project root), tolerating absence. */
export async function loadPersonaSources(cwd = process.cwd()): Promise<PersonaSources> {
  const read = async (path: string): Promise<string | undefined> => {
    try {
      const raw = await readFile(path, 'utf8');
      const trimmed = raw.trim();
      return trimmed.length ? trimmed : undefined;
    } catch {
      return undefined;
    }
  };
  const soul = await read(join(resolve(cwd), '.agentforge', 'SOUL.md'));
  const agents = await read(join(resolve(cwd), 'AGENTS.md'));
  return { soul, agents };
}

/** Synchronous variant for runner factories that cannot await. */
export function loadPersonaSourcesSync(cwd = process.cwd()): PersonaSources {
  const read = (path: string): string | undefined => {
    try {
      const raw = readFileSync(path, 'utf8');
      const trimmed = raw.trim();
      return trimmed.length ? trimmed : undefined;
    } catch {
      return undefined;
    }
  };
  const soul = read(join(resolve(cwd), '.agentforge', 'SOUL.md'));
  const agents = read(join(resolve(cwd), 'AGENTS.md'));
  return { soul, agents };
}

/**
 * Synchronous frozen snapshot for runner factories: preferred scope first,
 * same as loadMemory. Missing files yield an empty snapshot.
 */
export function loadMemorySync(target: MemoryTarget, cwd = process.cwd(), global = false): MemorySnapshot {
  const scopes: boolean[] = global ? [true, false] : [false, true];
  let entries: string[] = [];
  for (const scope of scopes) {
    try {
      const raw = readFileSync(fileFor(target, cwd, scope), 'utf8');
      entries = parseMemoryDocument(raw);
      break;
    } catch {
      continue;
    }
  }
  const limit = limitFor(target);
  const used = entries.reduce((sum, entry) => sum + entry.length, 0) + Math.max(0, entries.length - 1) * 3;
  return { target, entries, used, limit, ratio: limit > 0 ? used / limit : 0 };
}

/** Compose the persona block appended to agent instructions. */
export function renderPersonaBlock(sources: PersonaSources): string | undefined {
  const parts: string[] = [];
  if (sources.soul) parts.push(`[persona]\n${sources.soul}`);
  if (sources.agents) parts.push(`[project conventions — AGENTS.md]\n${sources.agents}`);
  return parts.length ? parts.join('\n\n') : undefined;
}
