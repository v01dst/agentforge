/**
 * LOCAL STAND-IN for `src/global-config.ts`.
 *
 * A sibling workstream owns the production `src/global-config.ts` exporting:
 *   globalConfigDir, readGlobalConfig, writeGlobalConfig, resolveActiveProvider,
 *   mergeProviderEntries, setGlobalDefault, validateProviderConnection,
 *   addRecentProject, detectProject
 *
 * That file did not exist at the time this registry rebuild was typed, so these
 * minimal-but-real implementations live here. When src/global-config.ts lands,
 * switch imports in registry.ts / ConnectWizard.tsx / DoctorScreen.tsx /
 * SkillsScreen.tsx from './local-global-config.js' to '../../global-config.js'
 * — the shapes below match the agreed signature list.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { ProviderEntry } from '../../providers-store.js';

export interface GlobalConfig {
  defaultProvider?: string;
  defaultModel?: string;
  recentProjects?: readonly string[];
  providers?: readonly ProviderEntry[];
  [key: string]: unknown;
}

export interface ActiveProviderInfo {
  provider: string;
  model?: string;
  source: 'env' | 'global-config' | 'none';
}

export interface ProjectDetectionResult {
  detected: boolean;
  /** Directory considered the project root. */
  root?: string;
  name?: string;
  /** Marker that was found (agentforge.config.ts, .agentforge/, package.json). */
  marker?: string;
}

export interface ConnectionCheckResult {
  ready: boolean;
  /** Why the connection is not ready, when ready === false. */
  reason?: string;
  /** Actionable remediation hint. */
  fix?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Directory holding global (cross-project) AgentForge state. */
export function globalConfigDir(opts: { dir?: string } = {}): string {
  return resolve(opts.dir ?? process.env.AGENTFORGE_CONFIG_DIR ?? join(homedir(), '.agentforge'));
}

const CONFIG_FILE = 'config.json';

function configFilePath(dir = globalConfigDir()): string {
  return join(dir, CONFIG_FILE);
}

export function readGlobalConfig(dir = globalConfigDir()): GlobalConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configFilePath(dir), 'utf8'));
    return isRecord(parsed) ? (parsed as GlobalConfig) : {};
  } catch {
    return {};
  }
}

export function writeGlobalConfig(config: GlobalConfig, dir = globalConfigDir()): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(configFilePath(dir), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/** Merge a partial patch into the global config (shallow). */
export function updateGlobalConfig(patch: Partial<GlobalConfig>, dir = globalConfigDir()): GlobalConfig {
  const next = { ...readGlobalConfig(dir), ...patch };
  writeGlobalConfig(next, dir);
  return next;
}

/**
 * Set the cross-project default provider/model. Secrets are never accepted
 * here — callers store credentials in environment variables.
 */
export function setGlobalDefault(
  patch: { provider?: string; model?: string },
  dir = globalConfigDir(),
): GlobalConfig {
  const next: Partial<GlobalConfig> = {};
  if (patch.provider !== undefined) next.defaultProvider = patch.provider;
  if (patch.model !== undefined) next.defaultModel = patch.model;
  return updateGlobalConfig(next, dir);
}

/** Resolve the provider/model that would be used right now. */
export function resolveActiveProvider(dir = globalConfigDir(), env: NodeJS.ProcessEnv = process.env): ActiveProviderInfo {
  if (env.AGENTFORGE_PROVIDER) {
    return { provider: env.AGENTFORGE_PROVIDER, model: env.AGENTFORGE_MODEL, source: 'env' };
  }
  const config = readGlobalConfig(dir);
  if (config.defaultProvider) {
    return { provider: config.defaultProvider, model: config.defaultModel, source: 'global-config' };
  }
  return { provider: '(none)', source: 'none' };
}

const PROJECT_MARKERS = ['agentforge.config.ts', 'agentforge.config.js', 'agentforge.config.mjs', '.agentforge'] as const;

/** Best-effort detection of an AgentForge project rooted at `cwd`. */
export function detectProject(cwd = process.cwd()): ProjectDetectionResult {
  const root = resolve(cwd);
  for (const marker of PROJECT_MARKERS) {
    if (existsSync(join(root, marker))) {
      return { detected: true, root, name: basename(root), marker };
    }
  }
  // A package.json alone counts as a weak project signal.
  if (existsSync(join(root, 'package.json'))) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      const name = isRecord(parsed) && typeof parsed.name === 'string' ? parsed.name : basename(root);
      return { detected: true, root, name, marker: 'package.json' };
    } catch {
      return { detected: true, root, name: basename(root), marker: 'package.json' };
    }
  }
  return { detected: false, root };
}

/** Remember a directory in the recent-projects list (most recent first, deduped). */
export function addRecentProject(projectDir: string, dir = globalConfigDir(), max = 10): readonly string[] {
  const config = readGlobalConfig(dir);
  const previous = Array.isArray(config.recentProjects) ? [...config.recentProjects] : [];
  const target = resolve(projectDir);
  const next = [target, ...previous.filter((entry) => entry !== target)].slice(0, max);
  updateGlobalConfig({ recentProjects: next }, dir);
  return next;
}

const CREDENTIAL_ENV: Record<string, readonly string[]> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  gemini: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
};

/**
 * Non-live readiness check for a provider connection: verifies that whatever
 * credential environment variables the provider needs are present. Never
 * returns or renders the secret itself.
 */
export function validateProviderConnection(options: {
  provider: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  live?: boolean;
}, env: NodeJS.ProcessEnv = process.env): ConnectionCheckResult {
  const provider = options.provider.toLowerCase();
  if (!options.baseUrl && provider === 'openai-compatible') {
    return { ready: false, reason: 'no base URL configured', fix: 'provide a Base URL (e.g. https://openrouter.ai/api/v1)' };
  }
  const candidates = options.apiKeyEnv ? [options.apiKeyEnv] : CREDENTIAL_ENV[provider] ?? [];
  if (candidates.length === 0) {
    return { ready: true };
  }
  const missing = candidates.filter((name) => !env[name]);
  if (missing.length === candidates.length) {
    return {
      ready: false,
      reason: `missing credential environment variable${candidates.length > 1 ? 's' : ''} ${candidates.join(' / ')}`,
      fix: `export ${candidates[0]}=<key> or re-enter it in this wizard`,
    };
  }
  return { ready: true };
}

/** Readable check used by the doctor checklist. */
export function pathReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
