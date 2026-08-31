import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readExtensions, type ExtensionsFile } from '../extensions/store.js';

/**
 * Plugin contract v2 (Phase N): a plugin is a local module whose default
 * export (or named `plugin` export) contributes any mix of capabilities to
 * the runtime. Everything is optional except `name`; unknown fields are
 * ignored so the contract can widen without breaking old plugins.
 *
 * Contributions:
 * - tools: core ToolLike objects
 * - instructions: system-prompt strings
 * - hooks: interceptor seam listeners (preStep/preRequest/preTool/postTool/turnStopping)
 * - skills: { name, body } loaded like project skills
 * - agents: markdown agent definitions (strings) for the agent registry
 * - slashCommands: { name, description, run(args) } surfaced in chat
 * - memoryProviders / channelAdapters / deviceTools: reserved shapes (validated loosely)
 */
export interface PluginHookContext {
  runId: string;
  sessionId?: string;
}

export interface PluginSlashCommand {
  name: string;
  description?: string;
  run: (args: string[]) => void | Promise<void>;
}

export interface AgentForgePlugin {
  name: string;
  description?: string;
  /** Compatibility level the plugin targets; CLI reports mismatches. */
  compat?: number;
  tools?: unknown[];
  instructions?: string | string[];
  hooks?: {
    preStep?: Array<(context: { input: string; runId: string }) => Promise<string | void>>;
    preRequest?: Array<(request: unknown) => Promise<unknown>>;
    preTool?: Array<(call: unknown) => Promise<string | void>>;
    postTool?: Array<(execution: unknown) => Promise<void>>;
    turnStopping?: Array<(result: { output: string; iterations: number }) => Promise<string | void>>;
  };
  skills?: Array<{ name: string; description?: string; body: string }>;
  agents?: string[];
  slashCommands?: PluginSlashCommand[];
  /** Reserved for Phase L/M: validated loosely so forward plugins load today. */
  memoryProviders?: unknown[];
  channelAdapters?: unknown[];
  deviceTools?: unknown[];
}

export interface LoadedPlugin {
  name: string;
  description?: string;
  path: string;
  compat?: number;
  tools: readonly string[];
  hasInstructions: boolean;
  hookCount: number;
  skills: readonly string[];
  agents: number;
  slashCommands: readonly string[];
  /** Contribution kinds present, for doctor + /plugins. */
  contributions: readonly string[];
  /** The live module for assembly. */
  plugin: AgentForgePlugin;
}

export interface PluginLoadResult {
  plugins: LoadedPlugin[];
  failures: Array<{ path: string; reason: string }>;
}

/** Contract level this CLI implements; plugins targeting older levels still load. */
export const PLUGIN_CONTRACT_VERSION = 2;

function asStringArray(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return [];
}

function countHooks(hooks: AgentForgePlugin['hooks']): number {
  if (!hooks) return 0;
  return Object.values(hooks).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
}

/** Normalize configured plugin entries into absolute module paths (order preserved). */
export function pluginPaths(extensions: ExtensionsFile | undefined, cwd = process.cwd()): string[] {
  const entries = extensions?.plugins ?? [];
  return entries.map((entry) => {
    const raw = typeof entry === 'string' ? entry : entry.path;
    return isAbsolute(raw) ? raw : resolve(cwd, raw);
  });
}

/** Disabled plugin paths from extensions.json (lifecycle: enable/disable), normalized absolute. */
export function disabledPluginKeys(extensions: ExtensionsFile | undefined, cwd = process.cwd()): Set<string> {
  const disabled = new Set<string>();
  for (const entry of extensions?.plugins ?? []) {
    if (typeof entry !== 'string' && entry.disabled) {
      const raw = entry.path;
      disabled.add(isAbsolute(raw) ? raw : resolve(cwd, raw));
    }
  }
  return disabled;
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
  if (record.instructions !== undefined && typeof record.instructions !== 'string' && !Array.isArray(record.instructions)) {
    throw new Error('plugin "instructions" must be a string or string[]');
  }
  if (record.hooks !== undefined && (typeof record.hooks !== 'object' || record.hooks === null || Array.isArray(record.hooks))) {
    throw new Error('plugin "hooks" must be an object of interceptor arrays');
  }
  if (record.slashCommands !== undefined && !Array.isArray(record.slashCommands)) {
    throw new Error('plugin "slashCommands" must be an array');
  }
  for (const command of record.slashCommands ?? []) {
    const item = command as Record<string, unknown> | null | undefined;
    if (!item || typeof item !== 'object' || typeof item.name !== 'string' || typeof item.run !== 'function') {
      throw new Error(`plugin "${String(record.name)}" contains a slash command without name/run`);
    }
  }
  const plugin = record as unknown as AgentForgePlugin;
  plugin.instructions = asStringArray(record.instructions).length ? asStringArray(record.instructions) : undefined;
  return plugin;
}

function contributionsOf(plugin: AgentForgePlugin): string[] {
  const kinds: string[] = [];
  if (plugin.tools?.length) kinds.push('tools');
  if (plugin.instructions?.length) kinds.push('instructions');
  if (countHooks(plugin.hooks) > 0) kinds.push('hooks');
  if (plugin.skills?.length) kinds.push('skills');
  if (plugin.agents?.length) kinds.push('agents');
  if (plugin.slashCommands?.length) kinds.push('slash-commands');
  if (plugin.memoryProviders?.length) kinds.push('memory-providers');
  if (plugin.channelAdapters?.length) kinds.push('channel-adapters');
  if (plugin.deviceTools?.length) kinds.push('device-tools');
  return kinds;
}

/**
 * Load every enabled plugin registered in `.agentforge/extensions.json`.
 * Never throws on individual plugin failure: failures are returned so
 * `doctor` can surface them and chat can continue with healthy plugins.
 */
export async function loadProjectPlugins(extensionsOverride?: ExtensionsFile, cwd = process.cwd()): Promise<PluginLoadResult> {
  const extensions = extensionsOverride ?? await readExtensions(cwd);
  const disabled = disabledPluginKeys(extensions, cwd);
  const plugins: LoadedPlugin[] = [];
  const failures: PluginLoadResult['failures'] = [];
  for (const path of pluginPaths(extensions, cwd)) {
    if (disabled.has(path)) continue; // lifecycle: disabled plugins stay unloaded
    try {
      const loaded = await importPluginModule(path);
      const plugin = coercePlugin(loaded.default ?? loaded.plugin, path);
      const hookCount = countHooks(plugin.hooks);
      const instructions = plugin.instructions ?? [];
      plugins.push({
        name: plugin.name,
        description: plugin.description,
        path,
        compat: plugin.compat,
        tools: (plugin.tools ?? []).map((tool) => String((tool as { name: unknown }).name)),
        hasInstructions: instructions.length > 0,
        hookCount,
        skills: (plugin.skills ?? []).map((skill) => skill.name),
        agents: plugin.agents?.length ?? 0,
        slashCommands: (plugin.slashCommands ?? []).map((command) => command.name),
        contributions: contributionsOf(plugin),
        plugin,
      });
    } catch (error) {
      failures.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { plugins, failures };
}

/** Flatten plugin contributions for agent assembly (enabled plugins only). */
export async function pluginContributions(extensionsOverride?: ExtensionsFile, cwd = process.cwd()): Promise<{
  tools: unknown[];
  instructions: string[];
  hooks: NonNullable<AgentForgePlugin['hooks']>;
  skills: Array<{ name: string; description?: string; body: string }>;
  slashCommands: PluginSlashCommand[];
  agents: string[];
}> {
  const extensions = extensionsOverride ?? await readExtensions(cwd);
  const disabled = disabledPluginKeys(extensions, cwd);
  const tools: unknown[] = [];
  const instructions: string[] = [];
  const skills: Array<{ name: string; description?: string; body: string }> = [];
  const slashCommands: PluginSlashCommand[] = [];
  const agents: string[] = [];
  const hooks: NonNullable<AgentForgePlugin['hooks']> = {};
  const paths = pluginPaths(extensions, cwd);
  for (const path of paths) {
    if (disabled.has(path)) continue;
    try {
      const loaded = await importPluginModule(path);
      const plugin = coercePlugin(loaded.default ?? loaded.plugin, path);
      tools.push(...plugin.tools ?? []);
      instructions.push(...plugin.instructions ?? []);
      skills.push(...plugin.skills ?? []);
      slashCommands.push(...plugin.slashCommands ?? []);
      agents.push(...plugin.agents ?? []);
      for (const [kind, listeners] of Object.entries(plugin.hooks ?? {})) {
        (hooks as Record<string, unknown[]>)[kind] = [
          ...((hooks as Record<string, unknown[]>)[kind] ?? []),
          ...(listeners as unknown[]),
        ];
      }
    } catch {
      // Surface through loadProjectPlugins/doctor; assembly stays best-effort.
    }
  }
  return { tools, instructions, hooks, skills, slashCommands, agents };
}

/** Read a plugin file for doctor display (kept tiny; no evaluation). */
export async function peekPluginSource(path: string): Promise<string> {
  return (await readFile(path, 'utf8')).slice(0, 400);
}
