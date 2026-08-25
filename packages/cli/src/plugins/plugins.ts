import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readExtensions, type ExtensionsFile } from '../extensions/store.js';

/**
 * A plugin is a local module whose default export (or named `plugin` export)
 * contributes tools and/or system instructions to the project agent.
 * Tools are core `ToolLike` objects: `{ name, description, inputSchema, execute }`.
 */
export interface AgentForgePlugin {
  name: string;
  description?: string;
  tools?: unknown[];
  instructions?: string;
}

export interface LoadedPlugin {
  name: string;
  description?: string;
  path: string;
  tools: readonly string[];
  hasInstructions: boolean;
}

export interface PluginLoadResult {
  plugins: LoadedPlugin[];
  failures: Array<{ path: string; reason: string }>;
}

/** Normalize configured plugin entries into absolute module paths. */
export function pluginPaths(extensions: ExtensionsFile | undefined, cwd = process.cwd()): string[] {
  const entries = extensions?.plugins ?? [];
  return entries.map((entry) => {
    const raw = typeof entry === 'string' ? entry : entry.path;
    return isAbsolute(raw) ? raw : resolve(cwd, raw);
  });
}

async function importPluginModule(path: string): Promise<Record<string, unknown>> {
  const specifier = pathToFileURL(path).href;
  try {
    return await import(specifier);
  } catch (error) {
    if (!path.endsWith('.ts') && !path.endsWith('.mts')) throw error;
    const api = await import('tsx/esm/api') as { tsImport?: (specifier: string, parent?: string) => Promise<Record<string, unknown>> };
    if (!api.tsImport) throw error;
    return await api.tsImport(specifier, import.meta.url);
  }
}

function coercePlugin(candidate: unknown, path: string): AgentForgePlugin {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('plugin module must default-export an object');
  }
  const record = candidate as Record<string, unknown>;
  if (typeof record.name !== 'string' || !record.name.trim()) {
    throw new Error('plugin object requires a non-empty "name" string');
  }
  const tools = record.tools;
  if (tools !== undefined && !Array.isArray(tools)) throw new Error('plugin "tools" must be an array of ToolLike objects');
  for (const tool of tools ?? []) {
    const item = tool as Record<string, unknown> | null | undefined;
    if (!item || typeof item !== 'object' || typeof item.name !== 'string' || typeof item.execute !== 'function') {
      throw new Error(`plugin "${String(record.name)}" contains a tool without name/execute`);
    }
  }
  if (record.instructions !== undefined && typeof record.instructions !== 'string') {
    throw new Error('plugin "instructions" must be a string');
  }
  return { name: record.name, description: typeof record.description === 'string' ? record.description : undefined, tools, instructions: record.instructions as string | undefined };
}

/**
 * Load every plugin registered in `.agentforge/extensions.json`.
 * Never throws on individual plugin failure: failures are returned so
 * `doctor` can surface them and chat can continue with healthy plugins.
 */
export async function loadProjectPlugins(extensionsOverride?: ExtensionsFile, cwd = process.cwd()): Promise<PluginLoadResult> {
  const extensions = extensionsOverride ?? await readExtensions(cwd);
  const paths = pluginPaths(extensions, cwd);
  const plugins: LoadedPlugin[] = [];
  const failures: PluginLoadResult['failures'] = [];
  for (const path of paths) {
    try {
      const loaded = await importPluginModule(path);
      const plugin = coercePlugin(loaded.default ?? loaded.plugin, path);
      plugins.push({
        name: plugin.name,
        description: plugin.description,
        path,
        tools: (plugin.tools ?? []).map((tool) => String((tool as { name: unknown }).name)),
        hasInstructions: Boolean(plugin.instructions),
      });
    } catch (error) {
      failures.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { plugins, failures };
}

/** Flatten plugin contributions for agent assembly. */
export async function pluginContributions(extensionsOverride?: ExtensionsFile, cwd = process.cwd()): Promise<{ tools: unknown[]; instructions: string[] }> {
  const extensions = extensionsOverride ?? await readExtensions(cwd);
  const tools: unknown[] = [];
  const instructions: string[] = [];
  const paths = pluginPaths(extensions, cwd);
  for (const path of paths) {
    try {
      const loaded = await importPluginModule(path);
      const plugin = coercePlugin(loaded.default ?? loaded.plugin, path);
      tools.push(...plugin.tools ?? []);
      if (plugin.instructions) instructions.push(plugin.instructions);
    } catch {
      // Surface through loadProjectPlugins/doctor; assembly stays best-effort.
    }
  }
  return { tools, instructions };
}

/** Read a plugin file for doctor display (kept tiny; no evaluation). */
export async function peekPluginSource(path: string): Promise<string> {
  return (await readFile(path, 'utf8')).slice(0, 400);
}
