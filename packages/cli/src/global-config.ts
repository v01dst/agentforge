import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Protocol kinds understood by AgentForge model endpoints. */
export type ProviderProtocol = 'openai' | 'anthropic' | 'google' | 'gemini' | 'openai-compatible';

/** A globally registered model endpoint. Credential VALUES are never stored — only env var names. */
export interface GlobalProviderEntry {
  name: string;
  protocol: ProviderProtocol;
  baseUrl?: string;
  model?: string;
  apiKeyEnv: string;
}

/** Shape of ~/.agentforge/config.json. */
export interface GlobalConfig {
  /** e.g. 'openai' | 'anthropic' | managed endpoint name */
  defaultProvider?: string;
  defaultModel?: string;
  providers: GlobalProviderEntry[];
  /** Absolute paths, most-recent first, max 10. */
  recentProjects: string[];
  /** Default true. */
  sessionHistory: boolean;
}

export const RECENT_PROJECT_LIMIT = 10;

const CONFIG_FILE = 'config.json';
const KNOWN_PROTOCOLS: ReadonlyArray<ProviderProtocol> = ['openai', 'anthropic', 'google', 'gemini', 'openai-compatible'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Ensure and return the global config directory (~/.agentforge by default). */
export async function globalConfigDir(dir = join(homedir(), '.agentforge')): Promise<string> {
  const target = resolve(dir);
  await mkdir(target, { recursive: true });
  return target;
}

function normalizeConfig(value: unknown): GlobalConfig {
  if (!isRecord(value)) return { providers: [], recentProjects: [], sessionHistory: true };
  const providers = Array.isArray(value.providers) ? value.providers.filter(isRecord) : [];
  return {
    defaultProvider: typeof value.defaultProvider === 'string' ? value.defaultProvider : undefined,
    defaultModel: typeof value.defaultModel === 'string' ? value.defaultModel : undefined,
    providers: providers.map((entry) => {
      const normalized: GlobalProviderEntry = {
        name: String(entry.name ?? ''),
        protocol: entry.protocol as ProviderProtocol,
        apiKeyEnv: String(entry.apiKeyEnv ?? ''),
      };
      if (typeof entry.baseUrl === 'string' && entry.baseUrl) normalized.baseUrl = entry.baseUrl;
      if (typeof entry.model === 'string' && entry.model) normalized.model = entry.model;
      return normalized;
    }),
    recentProjects: Array.isArray(value.recentProjects) ? value.recentProjects.filter((p): p is string => typeof p === 'string') : [],
    sessionHistory: value.sessionHistory !== false,
  };
}

/** Read the global config, returning sane defaults when absent or malformed. */
export async function readGlobalConfig(dir = join(homedir(), '.agentforge')): Promise<GlobalConfig> {
  const root = await globalConfigDir(dir);
  try {
    return normalizeConfig(JSON.parse(await readFile(join(root, CONFIG_FILE), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { providers: [], recentProjects: [], sessionHistory: true };
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Persist the global config atomically (tmp file + rename), pretty-printed.
 * Credential values must never be placed here — env var names only.
 */
export async function writeGlobalConfig(config: GlobalConfig, dir = join(homedir(), '.agentforge')): Promise<void> {
  const root = await globalConfigDir(dir);
  const finalPath = join(root, CONFIG_FILE);
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await rename(tmpPath, finalPath);
}

/** Where an active provider/model came from. */
export type ResolutionSource = 'env' | 'global' | 'default';

/** Resolved active provider + model per AGENTFORGE_* env → global defaults → fallbacks. */
export interface ActiveProviderResolution {
  provider: string;
  model?: string;
  source: ResolutionSource;
}

/** Resolve the active provider: env AGENTFORGE_PROVIDER → global defaultProvider → 'mock'; same ladder for model. */
export async function resolveActiveProvider(dir = join(homedir(), '.agentforge')): Promise<ActiveProviderResolution> {
  const config = await readGlobalConfig(dir);
  if (process.env.AGENTFORGE_PROVIDER) {
    return { provider: process.env.AGENTFORGE_PROVIDER, model: process.env.AGENTFORGE_MODEL, source: 'env' };
  }
  if (config.defaultProvider) {
    return { provider: config.defaultProvider, model: process.env.AGENTFORGE_MODEL ?? config.defaultModel, source: 'global' };
  }
  return { provider: 'mock', model: process.env.AGENTFORGE_MODEL, source: 'default' };
}

/** A merged endpoint tagged with where it came from. */
export interface ScopedProviderEntry extends GlobalProviderEntry {
  scope: 'global' | 'project';
}

/**
 * Merge global providers with project-level entries; project wins on name collision.
 */
export function mergeProviderEntries(globalEntries: readonly ScopedProviderEntry[] | readonly GlobalProviderEntry[], projectEntries: readonly GlobalProviderEntry[]): ScopedProviderEntry[] {
  const scoped: ScopedProviderEntry[] = (globalEntries as ReadonlyArray<GlobalProviderEntry>).map((entry) => ({ ...entry, scope: 'global' }));
  const byName = new Map(scoped.map((entry) => [entry.name, entry]));
  for (const entry of projectEntries) {
    const existing = byName.get(entry.name);
    const scopedEntry: ScopedProviderEntry = { ...entry, scope: 'project' };
    if (existing) {
      existing.name = scopedEntry.name;
      existing.protocol = scopedEntry.protocol;
      existing.baseUrl = scopedEntry.baseUrl;
      existing.model = scopedEntry.model;
      existing.apiKeyEnv = scopedEntry.apiKeyEnv;
      existing.scope = 'project';
    } else {
      scoped.push(scopedEntry);
      byName.set(entry.name, scopedEntry);
    }
  }
  return scoped;
}

/** Persist global default provider (and optional model). */
export async function setGlobalDefault(provider: string, model?: string, dir = join(homedir(), '.agentforge')): Promise<void> {
  const config = await readGlobalConfig(dir);
  config.defaultProvider = provider;
  if (model !== undefined) config.defaultModel = model;
  await writeGlobalConfig(config, dir);
}

/** Record a project path as recently used: dedupe, most-recent first, capped at 10. */
export async function addRecentProject(path: string, dir = join(homedir(), '.agentforge')): Promise<void> {
  const config = await readGlobalConfig(dir);
  const absolute = resolve(path);
  config.recentProjects = [absolute, ...config.recentProjects.filter((existing) => existing !== absolute)].slice(0, RECENT_PROJECT_LIMIT);
  await writeGlobalConfig(config, dir);
}

export interface ValidateConnectionOptions {
  /** Perform a tiny live HTTP request against the endpoint's models list. Never sends message content. */
  live?: boolean;
  /** AbortSignal for the live check. */
  signal?: AbortSignal;
}

export interface ConnectionValidation {
  ok: boolean;
  reason?: string;
}

const PROTOCOL_DEFAULT_URLS: Partial<Record<ProviderProtocol, string>> = {
  openai: 'https://api.openai.com/v1/models',
  anthropic: 'https://api.anthropic.com/v1/models',
  google: 'https://generativelanguage.googleapis.com/v1beta/models',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models',
};

function isLocalBaseUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch { return false; }
}

function modelsUrlFor(entry: Pick<GlobalProviderEntry, 'protocol' | 'baseUrl'>): string {
  if (entry.baseUrl) {
    const base = entry.baseUrl.replace(/\/+$/, '');
    return base.endsWith('/models') ? base : `${base}/models`;
  }
  return PROTOCOL_DEFAULT_URLS[entry.protocol] ?? '';
}

/**
 * Minimal connectivity validation. Without options this performs NO network
 * calls: protocol known-ness plus API-key env presence. With `{ live: true }`
 * issues a short-timeout GET of the platform's models endpoint — message
 * content is never sent.
 */
export async function validateProviderConnection(entry: Pick<GlobalProviderEntry, 'name' | 'protocol' | 'baseUrl' | 'apiKeyEnv'>, options: ValidateConnectionOptions = {}): Promise<ConnectionValidation> {
  if (!(KNOWN_PROTOCOLS as readonly string[]).includes(entry.protocol)) {
    return { ok: false, reason: `Unknown protocol '${String(entry.protocol)}' for provider '${entry.name}'.` };
  }
  const needsKey = entry.protocol === 'openai' || entry.protocol === 'anthropic' || entry.protocol === 'google' || entry.protocol === 'gemini';
  if (needsKey && !(entry.apiKeyEnv && process.env[entry.apiKeyEnv])) {
    return { ok: false, reason: `API key missing: set ${entry.apiKeyEnv || 'an apiKeyEnv'} in the environment for '${entry.name}' (${entry.protocol}).` };
  }
  if (!needsKey && entry.protocol === 'openai-compatible' && entry.apiKeyEnv && !process.env[entry.apiKeyEnv] && !isLocalBaseUrl(entry.baseUrl ?? '')) {
    return { ok: false, reason: `Remote openai-compatible endpoint requires ${entry.apiKeyEnv} to be set.` };
  }
  if (!options.live) return { ok: true };
  const url = modelsUrlFor(entry);
  if (!url) return { ok: false, reason: `No baseUrl configured for live check of '${entry.name}' (${entry.protocol}).` };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const headers: Record<string, string> = {};
    if (entry.apiKeyEnv && process.env[entry.apiKeyEnv]) {
      const key = process.env[entry.apiKeyEnv] as string;
      if (entry.protocol === 'anthropic') { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
      else if (entry.protocol === 'google' || entry.protocol === 'gemini') headers['x-goog-api-key'] = key;
      else headers.authorization = `Bearer ${key}`;
    }
    const response = await fetch(url, { method: 'GET', headers, signal: options.signal ?? controller.signal });
    if (!response.ok) return { ok: false, reason: `Live check failed with HTTP ${response.status} from ${url}.` };
    return { ok: true };
  } catch (error) {
    const aborted = (error as Error).name === 'AbortError';
    return { ok: false, reason: aborted ? `Live check timed out after 5s against ${url}.` : `Live check failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timeout);
  }
}
