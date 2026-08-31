import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { z } from 'zod';
import { defineTool } from './tool.js';

/** Directories never listed or searched regardless of gitignore contents. */
const ALWAYS_SKIP = new Set(['node_modules', '.git', 'dist']);

/** A single parsed .gitignore rule (negation rules are parsed but not applied). */
interface IgnoreRule {
  readonly negated: boolean;
  /** Matches directory entries only when the pattern ends with '/'. */
  readonly dirOnly: boolean;
  /** Anchored to the root of the ignore file's directory. */
  readonly anchored: boolean;
  readonly regex: RegExp;
}

/**
 * Converts one gitignore line into a matcher. Supports comments (`#`),
 * trailing-slash directory patterns, leading-slash anchors and `*` wildcards.
 * Negation lines are recognised so they can be skipped rather than misread.
 */
function parseIgnoreLine(line: string): IgnoreRule | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const negated = trimmed.startsWith('!');
  if (negated) return null; // negation unsupported by this minimal matcher
  const dirOnly = trimmed.endsWith('/');
  let pattern = dirOnly ? trimmed.slice(0, -1) : trimmed;
  const anchored = pattern.startsWith('/');
  if (anchored) pattern = pattern.slice(1);
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  // Unanchored patterns match at any depth; anchored ones only from the root.
  const body = anchored ? `^${source}(/.*)?$` : `(^|/)${source}(/.*)?$`;
  return { negated: false, dirOnly, anchored, regex: new RegExp(body) };
}

/** Reads and parses a .gitignore in `dir`, returning its compiled rules. */
async function loadIgnoreRules(dir: string): Promise<IgnoreRule[]> {
  let raw: string;
  try {
    raw = await readFile(join(dir, '.gitignore'), 'utf8');
  } catch {
    return [];
  }
  const rules: IgnoreRule[] = [];
  for (const line of raw.split('\n')) {
    const rule = parseIgnoreLine(line);
    if (rule) rules.push(rule);
  }
  return rules;
}

function isIgnored(relPath: string, isDir: boolean, rules: IgnoreRule[]): boolean {
  if (!rules.length) return false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.regex.test(relPath)) return true;
  }
  return false;
}

/** Same path-escape guard used by filesystem.ts. */
function makeSafePath(root: string) {
  return (value: string) => {
    const full = resolve(root, value);
    const rel = relative(root, full);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Path escapes the configured filesystem root');
    return full;
  };
}

/**
 * Basenames that are refused by read tools by default: credential and
 * secret-bearing files. `.env.example` is explicitly allowed.
 */
export const SECRET_FILE_BASENAMES = new Set([
  '.env',
  '.netrc',
  '.git-credentials',
  '.htpasswd',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);

/** Returns true when a workspace-relative path points at a secret-bearing file. */
export function isSecretFilePath(relPath: string): boolean {
  const segments = relPath.split('/');
  const basename = segments[segments.length - 1] ?? '';
  if (!basename) return false;
  if (basename === '.env.example') return false;
  if (SECRET_FILE_BASENAMES.has(basename)) return true;
  if (basename.startsWith('.env.')) return true;
  if (segments.includes('.ssh')) return true;
  if (/\.(pem|key|p12|pfx|keystore)$/.test(basename)) return true;
  return false;
}

export interface ListFilesToolOptions {
  root: string;
  /** Maximum number of file entries returned before truncation. Default 5_000. */
  maxEntries?: number;
}

/**
 * Creates the `list_files` tool: recursively lists files under a workspace
 * root, always skipping node_modules/.git/dist and honouring .gitignore rules.
 */
export function createListFilesTool(options: ListFilesToolOptions) {
  const root = resolve(options.root);
  const maxEntries = options.maxEntries ?? 5_000;
  return defineTool({
    name: 'list_files',
    description: 'Recursively list files under the workspace root, respecting .gitignore.',
    permissions: ['filesystem:read'],
    timeoutMs: 30_000,
    input: z.object({}),
    output: z.object({ files: z.array(z.string()), truncated: z.boolean() }),
    async execute(): Promise<{ files: string[]; truncated: boolean }> {
      const files: string[] = [];
      let truncated = false;
      const walk = async (dir: string, relBase: string, inherited: IgnoreRule[]): Promise<void> => {
        if (truncated) return;
        // .gitignore rules cascade: a directory's rules also apply to its subtree.
        const rules = [...inherited, ...(await loadIgnoreRules(dir))];
        let names: string[];
        try {
          names = await readdir(dir);
        } catch {
          return;
        }
        for (const name of names.sort()) {
          if (ALWAYS_SKIP.has(name)) continue;
          const full = join(dir, name);
          const rel = relBase ? `${relBase}/${name}` : name;
          let info;
          try {
            info = await stat(full);
          } catch {
            continue;
          }
          const isDir = info.isDirectory();
          if (isIgnored(rel, isDir, rules)) continue;
          if (isDir) await walk(full, rel, rules);
          else {
            if (files.length >= maxEntries) {
              truncated = true;
              return;
            }
            files.push(rel);
          }
        }
      };
      await walk(root, '', []);
      return { files, truncated };
    },
  });
}

export interface ReadFileToolOptions {
  root: string;
  /** Maximum number of bytes read from any single file. Default 256 KiB. */
  maxBytes?: number;
  /** Allow reading credential/secret files (.env, keys, id_rsa, ...). Default false. */
  allowSecretFiles?: boolean;
}

const readFileInput = z.object({
  path: z.string(),
  offsetLine: z.number().int().min(1).optional(),
  maxLines: z.number().int().min(1).max(2000).optional(),
});

/**
 * Creates the `read_file` tool: bounded, line-windowed reads confined to the
 * workspace root via the same safePath escape protection as filesystem.ts.
 */
export function createReadFileTool(options: ReadFileToolOptions) {
  const root = resolve(options.root);
  const safePath = makeSafePath(root);
  const maxBytes = options.maxBytes ?? 262_144;
  const allowSecretFiles = options.allowSecretFiles ?? false;
  return defineTool({
    name: 'read_file',
    description: 'Read a bounded slice of a file inside the workspace root. Credential and secret files are refused by default.',
    permissions: ['filesystem:read'],
    timeoutMs: 15_000,
    input: readFileInput,
    output: z.object({
      path: z.string(),
      totalLines: z.number(),
      startLine: z.number(),
      content: z.string(),
      bytes: z.number(),
      truncated: z.boolean(),
    }),
    async execute(input): Promise<{
      path: string; totalLines: number; startLine: number; content: string; bytes: number; truncated: boolean;
    }> {
      const full = safePath(input.path);
      const rel = relative(root, full);
      if (!allowSecretFiles && isSecretFilePath(rel)) {
        throw new Error(`Refusing to read '${input.path}': secret/credential files are protected. Enable allowSecretFiles explicitly to override.`);
      }
      const buffer = await readFile(full);
      const bytes = Math.min(buffer.byteLength, maxBytes);
      const truncatedBySize = buffer.byteLength > maxBytes;
      let text = buffer.subarray(0, bytes).toString('utf8');
      if (text.endsWith('\n')) text = text.slice(0, -1); // don't count a trailing newline as an extra line
      if (truncatedBySize) text = text.slice(0, text.lastIndexOf('\n') > 0 ? text.lastIndexOf('\n') : 0);
      const lines = text.length ? text.split('\n') : [];
      const totalLines = lines.length;
      const startLine = input.offsetLine ?? 1;
      if (startLine > totalLines) {
        return { path: input.path, totalLines, startLine, content: '', bytes, truncated: true };
      }
      const maxLines = input.maxLines ?? 2_000;
      const end = Math.min(startLine - 1 + maxLines, totalLines);
      const content = lines.slice(startLine - 1, end).join('\n');
      return { path: input.path, totalLines, startLine, content, bytes, truncated: end < totalLines };
    },
  });
}

export interface SearchTextToolOptions {
  root: string;
  /** Maximum matches returned before truncation. Default 200. */
  maxResults?: number;
}

const searchTextInput = z.object({
  pattern: z.string(),
  glob: z.string().optional(),
  isRegex: z.boolean().default(false),
  caseSensitive: z.boolean().default(false),
  maxResults: z.number().int().min(1).optional(),
});

/** Minimal glob-to-regex for optional filtering: supports *, ** and ? over '/'. */
function globToRegExp(glob: string): RegExp {
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${source}$`);
}

/**
 * Creates the `search_text` tool: literal or regex search across non-ignored
 * files under the workspace root, returning per-line matches.
 */
export function createSearchTextTool(options: SearchTextToolOptions) {
  const root = resolve(options.root);
  const defaultMaxResults = options.maxResults ?? 200;
  return defineTool({
    name: 'search_text',
    description: 'Search file contents under the workspace root by literal text or regular expression.',
    permissions: ['filesystem:read'],
    timeoutMs: 30_000,
    input: searchTextInput,
    output: z.object({
      matches: z.array(z.object({ path: z.string(), line: z.number(), text: z.string() })),
      truncated: z.boolean(),
    }),
    async execute(input): Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean }> {
      let matcher: RegExp;
      try {
        const source = input.isRegex ? input.pattern : input.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        matcher = new RegExp(source, input.caseSensitive ? '' : 'i');
      } catch (error) {
        throw new Error(`Invalid search pattern: ${(error as Error).message}`);
      }
      const globFilter = input.glob ? globToRegExp(input.glob) : null;
      const limit = input.maxResults ?? defaultMaxResults;
      const matches: Array<{ path: string; line: number; text: string }> = [];
      let truncated = false;

      const walk = async (dir: string, relBase: string, inherited: IgnoreRule[]): Promise<void> => {
        if (truncated) return;
        // .gitignore rules cascade: a directory's rules also apply to its subtree.
        const rules = [...inherited, ...(await loadIgnoreRules(dir))];
        let names: string[];
        try {
          names = await readdir(dir);
        } catch {
          return;
        }
        for (const name of names.sort()) {
          if (ALWAYS_SKIP.has(name)) continue;
          const full = join(dir, name);
          const rel = relBase ? `${relBase}/${name}` : name;
          let info;
          try {
            info = await stat(full);
          } catch {
            continue;
          }
          if (info.isDirectory()) {
            if (!isIgnored(rel, true, rules)) await walk(full, rel, rules);
            continue;
          }
          if (isIgnored(rel, false, rules)) continue;
          if (isSecretFilePath(rel)) continue;
          if (globFilter && !globFilter.test(rel)) continue;
          if (info.size > 1_000_000) continue;
          let text: string;
          try {
            text = await readFile(full, 'utf8');
          } catch {
            continue;
          }
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const lineText = lines[i] ?? '';
            if (matcher.test(lineText)) {
              if (matches.length >= limit) {
                truncated = true;
                return;
              }
              matches.push({ path: rel, line: i + 1, text: lineText });
            }
          }
        }
      };
      await walk(root, '', []);
      return { matches, truncated };
    },
  });
}
