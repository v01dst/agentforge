import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentForgeConfig } from './types.js';

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

export async function loadConfig(options: { cwd?: string; required?: boolean } = {}): Promise<{ path?: string; config: AgentForgeConfig }> {
  const path = await findConfigFile(options.cwd);
  if (!path) {
    if (options.required) throw new Error('No agentforge.config.ts found. Run `agentforge init <name>` or pass an explicit entrypoint.');
    return { config: {} };
  }
  const loaded = await importConfig(path);
  const config = (loaded.default ?? loaded.config ?? loaded) as AgentForgeConfig;
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`Invalid AgentForge config in ${path}`);
  return { path, config };
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
