import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentForgeConfig, NamedEntry } from './types.js';
import { readProviderEntries } from './providers-store.js';

const CONFIG_NAMES = [
  'agentforge.config.ts',
  'agentforge.config.mts',
  'agentforge.config.js',
  'agentforge.config.mjs',
  'agentforge.config.cjs',
] as const;

async function exists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

export async function findConfigFile(start = process.cwd()): Promise<string | undefined> {
  let current = resolve(start);
  while (true) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(current, name);
      if (await exists(candidate)) return candidate;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

type TsImport = (specifier: string, parent?: string) => Promise<Record<string, unknown>>;

async function importConfig(path: string): Promise<Record<string, unknown>> {
  const specifier = pathToFileURL(path).href;
  try {
    const loaded = await import(specifier);
    return loaded as Record<string, unknown>;
  } catch (error) {
    if (!path.endsWith('.ts') && !path.endsWith('.mts')) throw error;
    const api = await import('tsx/esm/api') as unknown as { tsImport?: TsImport };
    if (!api.tsImport) throw error;
    return await api.tsImport(specifier, import.meta.url);
  }
}

/** Merge CLI-managed sidecar providers into config providers; config names win on collision. */
export function mergeProviderEntries(config: AgentForgeConfig, sidecar: readonly NamedEntry[]): AgentForgeConfig {
  if (!sidecar.length) return config;
  const configured = new Set((config.providers ?? []).map((entry) => typeof entry === 'string' ? entry : entry.name));
  const additions = sidecar.filter((entry) => !configured.has(entry.name));
  if (!additions.length) return config;
  return { ...config, providers: [...(config.providers ?? []), ...additions] };
}

async function readSidecarProviders(cwd: string): Promise<NamedEntry[]> {
  const entries = await readProviderEntries(cwd);
  return entries.map((entry) => ({ name: entry.name, protocol: entry.protocol, model: entry.model, baseUrl: entry.baseUrl, apiKeyEnv: entry.apiKeyEnv }));
}

export async function loadConfig(options: { cwd?: string; required?: boolean } = {}): Promise<{ path?: string; config: AgentForgeConfig }> {
  const cwd = options.cwd ?? process.cwd();
  const path = await findConfigFile(cwd);
  let loadedConfig: AgentForgeConfig;
  if (!path) {
    if (options.required) throw new Error('No agentforge.config.ts found. Run `agentforge init <name>` or pass an explicit entrypoint.');
    loadedConfig = {};
  } else {
    const loaded = await importConfig(path);
    const candidate = (loaded.default ?? loaded.config ?? loaded) as AgentForgeConfig;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error(`Invalid AgentForge config in ${path}`);
    loadedConfig = candidate;
  }
  let sidecar: NamedEntry[] = [];
  try {
    sidecar = await readSidecarProviders(cwd);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} (found while loading model providers)`);
  }
  return { path, config: mergeProviderEntries(loadedConfig, sidecar) };
}

export async function discoverEntries(cwd = process.cwd()): Promise<string[]> {
  const names = new Set<string>();
  const { config } = await loadConfig({ cwd });
  for (const key of ['providers', 'tools', 'workflows'] as const) {
    for (const item of config[key] ?? []) names.add(typeof item === 'string' ? item : item.name);
  }
  if (names.size) return [...names];
  try {
    const files = await readdir(cwd);
    return files.filter((file) => /\.(ts|mts|js|mjs)$/.test(file) && !file.endsWith('.config.ts')).sort();
  } catch { return []; }
}
