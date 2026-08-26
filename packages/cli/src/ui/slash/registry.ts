import { chdir } from 'node:process';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { connectCommand, pluginsCommand, testCommand, VERSION } from '../../commands.js';
import { loadConfig } from '../../config.js';
import { createCodingTools } from '../../coding-tools.js';
import { currentPermissionMode } from '../../permissions-state.js';
import { buildModelReport } from '../../session.js';
import { readProviderEntries } from '../../providers-store.js';
import {
  addRecentProject,
  resolveActiveProvider,
  validateProviderConnection,
} from '../../global-config.js';
import { detectProject } from '../../runtime-session.js';

/**
 * Central slash-command router.
 *
 * Backward-compatible exports kept: `buildSlashRegistry`, `parseSlashInput`,
 * `SlashHandlers` (extended with optional fields), and each entry still
 * exposes `action(args)` in addition to the new `run(args, ctx)`.
 */

export type SlashScreen =
  | 'tools'
  | 'workflows'
  | 'agents'
  | 'runs'
  | 'settings'
  | 'models'
  | 'help'
  | 'doctor-result'
  | 'doctor'
  | 'connect'
  | 'new-project'
  | 'run'
  | 'inspect'
  | 'skills';

export interface SlashCommandSpec {
  name: string;
  aliases?: readonly string[];
  description: string;
  usage?: string;
  argsHint?: readonly string[];
  /** When truthy and no project is detected, the handler explains and suggests /new or /cd instead of failing. */
  requiresProject?: false | 'explain';
  category: 'session' | 'config' | 'resources' | 'project' | 'system';
}

export interface CommandContext {
  mode: () => 'global' | 'project';
  pushSystem: (t: string) => void;
  clearConversation: () => void;
  exitRequested: () => void;
  openScreen: (screen: SlashScreen, arg?: string) => void;
  runSuspended: (fn: () => Promise<number>) => Promise<void>;
  setSessionModel: (model: string) => void;
  refreshStatus: () => void;
}

/** Legacy handler shape; all new fields are optional so old call sites compile. */
export interface SlashHandlers {
  openScreen: (screen: SlashScreen, arg?: string) => void;
  /** Unmount ink -> run fn -> wait Enter -> remount; console output is safe inside. */
  runSuspended: (fn: () => Promise<number>) => Promise<void>;
  pushSystem: (text: string) => void;
  clearConversation: () => void;
  exitRequested: () => void;
  mode?: () => 'global' | 'project';
  setSessionModel?: (model: string) => void;
  refreshStatus?: () => void;
}

export type CommandRun = (args: string[], ctx: CommandContext) => void | Promise<void>;

export interface RegisteredCommand extends SlashCommandSpec {
  run: CommandRun;
  /** Backward-compatible single-arg entry point (uses the registry's context). */
  action: (args: string[]) => void | Promise<void>;
}

/** Legacy alias for the registered-command list. */
export type SlashEntry = RegisteredCommand;

export type SlashAction = SlashEntry['action'];

const NO_PROJECT_HINT =
  '(no project detected — run /new to scaffold one here, or /cd <path> to switch to an existing project directory)';

/** Normalize raw input ("/model x") to a command name + args, or null for non-commands. */
export function parseSlashInput(input: string): { name: string; args: string[] } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/') || trimmed.length < 2) return null;
  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return { name: parts[0]!, args: parts.slice(1) };
}

async function currentModelNames(): Promise<string[]> {
  let merged: unknown[] = [];
  try {
    const loaded = await loadConfig({ required: false });
    const raw = (loaded.config as { providers?: unknown }).providers;
    if (Array.isArray(raw)) merged = [...raw];
  } catch {
    merged = [];
  }
  try {
    merged = [...merged, ...(await readProviderEntries())];
  } catch {
    /* sidecar providers unavailable */
  }
  return buildModelReport(merged as never).map((row) => row.provider);
}

export function buildSlashRegistry(handlers: SlashHandlers): RegisteredCommand[] {
  const ctx: CommandContext = {
    mode: handlers.mode ?? (() => 'global'),
    pushSystem: handlers.pushSystem,
    clearConversation: handlers.clearConversation,
    exitRequested: handlers.exitRequested,
    openScreen: handlers.openScreen,
    runSuspended: handlers.runSuspended,
    setSessionModel: handlers.setSessionModel ?? ((model: string) => { process.env.AGENTFORGE_MODEL = model; }),
    refreshStatus: handlers.refreshStatus ?? (() => { /* no-op when host has no status bar */ }),
  };

  function guardProject(): boolean {
    if (ctx.mode() === 'project') return true;
    ctx.pushSystem(NO_PROJECT_HINT);
    return false;
  }

  const commands: Array<Omit<RegisteredCommand, 'action'> & { interactive?: boolean }> = [
    {
      name: 'help',
      description: 'Browse all commands (palette)',
      usage: '/help',
      category: 'system',
      run: () => ctx.openScreen('help'),
    },
    {
      name: 'connect',
      description: 'Set up a provider interactively (works without a project)',
      usage: '/connect',
      category: 'config',
      run: () => ctx.openScreen('connect'),
    },
    {
      name: 'providers',
      description: 'Open the Models & Providers manager',
      usage: '/providers',
      category: 'config',
      run: () => ctx.openScreen('models'),
    },
    {
      name: 'models',
      description: 'Open the Models & Providers manager',
      usage: '/models',
      category: 'config',
      run: () => ctx.openScreen('models'),
    },
    {
      name: 'model',
      description: 'Show or set the session model',
      usage: '/model [name]',
      argsHint: ['model name — e.g. gpt-4o-mini, claude-sonnet-4, gemini-2.0-flash'],
      category: 'config',
      run: async (args) => {
        const name = args[0];
        if (!name) {
          ctx.pushSystem(`Current model: ${process.env.AGENTFORGE_MODEL ?? '(unset)'}`);
          return;
        }
        const names = await currentModelNames();
        const known = new Set(names.map((candidate) => candidate.toLowerCase()));
        if (known.size > 0 && !known.has(name.toLowerCase())) {
          ctx.pushSystem(`✗ unknown model '${name}' — known models:\n  ${names.join('\n  ')}\nUse /models to manage endpoints.`);
          return;
        }
        process.env.AGENTFORGE_MODEL = name;
        ctx.setSessionModel(name);
        ctx.refreshStatus();
        ctx.pushSystem(`Model set to ${name}`);
      },
    },
    {
      name: 'tools',
      description: 'Browse configured and built-in tools',
      usage: '/tools',
      category: 'resources',
      run: () => ctx.openScreen('tools'),
    },
    {
      name: 'skills',
      description: 'List project + global skills',
      usage: '/skills',
      category: 'resources',
      run: () => ctx.openScreen('skills'),
    },
    {
      name: 'plugins',
      description: 'List registered plugins and their contributions',
      usage: '/plugins',
      category: 'resources',
      run: () => ctx.runSuspended(() => pluginsCommand({})),
    },
    {
      name: 'skin',
      description: 'Switch the TUI skin: forge | midnight | paper',
      usage: '/skin [name]',
      category: 'config',
      run: async (args, cmdCtx) => {
        const { BUILT_IN_SKINS, listSkinNames, resolveSkin, saveSkinSelection, setActiveSkin } = await import('../../ui/skin.js');
        const target = args[0];
        if (!target || !BUILT_IN_SKINS[target]) {
          const current = (await resolveSkin()).skin.name;
          const lines = listSkinNames().map((name) => `${name === current ? '›' : ' '} ${name.padEnd(9)} ${BUILT_IN_SKINS[name]?.description ?? ''}`);
          cmdCtx.pushSystem(`skins (current: ${current})\n  ${lines.join('\n  ')}\nSwitch with /skin <name>`);
          if (target && !BUILT_IN_SKINS[target]) return;
          return;
        }
        await saveSkinSelection({ skin: target }, process.cwd(), true);
        setActiveSkin((await resolveSkin({ name: target })).skin);
        cmdCtx.refreshStatus();
        cmdCtx.pushSystem(`skin set to ${target} (saved to ~/.agentforge/skin.json)`);
      },
    },
    {
      name: 'agents',
      description: 'Pick an agent entry to run',
      usage: '/agents',
      requiresProject: 'explain',
      category: 'resources',
      run: () => {
        if (!guardProject()) return;
        ctx.openScreen('run');
      },
    },
    {
      name: 'workflows',
      description: 'Browse and run workflows',
      usage: '/workflows',
      requiresProject: 'explain',
      category: 'resources',
      run: () => {
        if (!guardProject()) return;
        ctx.openScreen('workflows');
      },
    },
    {
      name: 'runs',
      description: 'Browse recent runs',
      usage: '/runs',
      requiresProject: 'explain',
      category: 'resources',
      run: () => {
        if (ctx.mode() === 'global') {
          ctx.pushSystem('(no runs — runs are stored per project)\n' + NO_PROJECT_HINT);
          return;
        }
        ctx.openScreen('runs');
      },
    },
    {
      name: 'inspect',
      description: 'Inspect a run by id',
      usage: '/inspect <id>',
      argsHint: ['run id — see /runs'],
      requiresProject: 'explain',
      category: 'resources',
      run: (args) => {
        const id = args[0];
        if (!id) {
          ctx.pushSystem('Usage: /inspect <id>');
          return;
        }
        if (ctx.mode() === 'global') {
          ctx.pushSystem(`(no runs — runs are stored per project; cannot inspect '${id}')\n` + NO_PROJECT_HINT);
          return;
        }
        ctx.openScreen('inspect', id);
      },
    },
    {
      name: 'test',
      description: 'Run the project test suite',
      usage: '/test',
      requiresProject: 'explain',
      interactive: true,
      category: 'project',
      run: () => ctx.runSuspended(() => testCommand([])),
    },
    {
      name: 'doctor',
      description: 'Interactive environment checklist',
      usage: '/doctor',
      category: 'system',
      run: () => ctx.openScreen('doctor'),
    },
    {
      name: 'config',
      description: 'Open session settings',
      usage: '/config',
      category: 'config',
      run: () => ctx.openScreen('settings'),
    },
    {
      name: 'settings',
      description: 'Open session settings',
      usage: '/settings',
      category: 'config',
      run: () => ctx.openScreen('settings'),
    },
    {
      name: 'status',
      description: 'Show detailed session status',
      usage: '/status',
      category: 'system',
      run: () => {
        void (async () => {
          const project = await detectProject();
          const active = await resolveActiveProvider();
          const lines = [
            `mode: ${project.found ? 'project' : 'global (session mode)'}`,
            `cwd: ${process.cwd()}`,
            `detected project: ${project.found ? project.path : 'none — run /new or /cd <path>'}`,
            `provider: ${active.provider}${active.model ? ` · model: ${active.model}` : ''} (${active.source})`,
            `session: ${process.env.AGENTFORGE_MODEL ? `active (model ${process.env.AGENTFORGE_MODEL})` : 'active (default model)'}`,
            `permission mode: ${currentPermissionMode()}`,
          ];
          ctx.pushSystem(lines.join('\n'));
        })();
      },
    },
    {
      name: 'clear',
      description: 'Clear the conversation',
      usage: '/clear',
      category: 'session',
      run: () => ctx.clearConversation(),
    },
    {
      name: 'exit',
      description: 'Exit AgentForge',
      usage: '/exit',
      aliases: ['quit'],
      category: 'session',
      run: () => ctx.exitRequested(),
    },
    {
      name: 'version',
      description: 'Show the AgentForge version',
      usage: '/version',
      category: 'system',
      run: () => ctx.pushSystem(`AgentForge ${VERSION}`),
    },
    {
      name: 'reload',
      description: 'Re-detect the project and refresh state',
      usage: '/reload',
      interactive: true,
      category: 'system',
      run: () =>
        ctx.runSuspended(async () => {
          const previousCwd = process.cwd();
          console.log(`Reloading project state for ${previousCwd} …`);
          const after = await detectProject(previousCwd);
          console.log(
            after.found
              ? `Project detected: ${after.path}.`
              : 'No change: no project detected — global/session mode.',
          );
          return 0;
        }),
    },
    {
      name: 'cd',
      description: 'Change directory (and project); no argument goes home',
      usage: '/cd <path>',
      argsHint: ['directory path, ~ accepted; empty = home'],
      category: 'project',
      run: (args) => {
        const target = args[0] ? (args[0].startsWith('~') ? joinHome(args[0]) : args[0]) : homedir();
        let resolved: string;
        try {
          resolved = resolvePath(process.cwd(), target);
          process.chdir(resolved);
        } catch (error) {
          ctx.pushSystem(`✗ /cd failed: ${(error as Error).message}`);
          return;
        }
        void (async () => {
          await addRecentProject(resolved);
          const project = await detectProject(resolved);
          ctx.pushSystem([
            `cwd → ${resolved}`,
            `project: ${project.found ? project.path : 'none — session mode'}`,
            `recent projects: see ~/.agentforge/config.json`,
          ].join('\n'));
          ctx.refreshStatus();
        })();
      },
    },
    {
      name: 'new',
      description: 'Create a new project',
      usage: '/new',
      aliases: ['init', 'project'],
      category: 'project',
      run: () => ctx.openScreen('new-project'),
    },
    {
      name: 'chat',
      description: 'Return to chat (you are already here)',
      usage: '/chat',
      category: 'session',
      run: () => ctx.pushSystem('You are already in the chat.'),
    },
  ];

  // Every command gets a backward-compatible `action(args)` that routes through
  // run() with the shared context; both paths catch errors into pushSystem.
  return commands.map((command) => {
    const registered: RegisteredCommand = { ...command, action: (args: string[]) => executeRegistered(registered, args, ctx) };
    return registered;
  });

  // -- local helpers ---------------------------------------------------------

  function executeRegistered(command: RegisteredCommand, args: string[], context: CommandContext): void | Promise<void> {
    try {
      const result = command.run(args, context);
      if (result && typeof (result as Promise<void>).then === 'function') {
        return (result as Promise<void>).catch((error: unknown) => reportFailure(command.name, error, context));
      }
      return result;
    } catch (error) {
      reportFailure(command.name, error, context);
      return undefined;
    }
  }
}

function reportFailure(name: string, error: unknown, ctx: CommandContext): void {
  const message = error instanceof Error ? error.message : String(error);
  ctx.pushSystem(`✗ /${name} failed: ${message} — try /help`);
}

function joinHome(pathWithTilde: string): string {
  const rest = pathWithTilde.slice(1).replace(/^[/\\]/, '');
  return rest ? `${homedir()}/${rest}` : homedir();
}

/** Resolve a command by name or alias. */
export function dispatchSlash(
  registry: readonly RegisteredCommand[],
  input: string,
  pushSystemOrCtx: ((text: string) => void) | CommandContext,
): boolean {
  const parsed = parseSlashInput(input);
  if (!parsed) return false;
  const pushSystem = typeof pushSystemOrCtx === 'function' ? pushSystemOrCtx : pushSystemOrCtx.pushSystem;
  const ctx: CommandContext = typeof pushSystemOrCtx === 'function'
    ? fallbackContext(pushSystem)
    : pushSystemOrCtx;
  const entry = findCommand(registry, parsed.name);
  if (!entry) {
    pushSystem(`Unknown command: /${parsed.name} — try /help`);
    return true;
  }
  void executeSafe(entry, parsed.args, ctx);
  return true;
}

function fallbackContext(pushSystem: (text: string) => void): CommandContext {
  return {
    mode: () => 'global',
    pushSystem,
    clearConversation: () => { /* legacy no-op */ },
    exitRequested: () => process.exit(0),
    openScreen: () => { /* legacy no-op */ },
    runSuspended: async (fn) => { await fn(); },
    setSessionModel: (model) => { process.env.AGENTFORGE_MODEL = model; },
    refreshStatus: () => { /* no-op */ },
  };
}

function executeSafe(entry: RegisteredCommand, args: string[], ctx: CommandContext): void {
  try {
    const result = entry.run(args, ctx);
    if (result && typeof (result as Promise<void>).catch === 'function') {
      void (result as Promise<void>).catch((error: unknown) => reportFailure(entry.name, error, ctx));
    }
  } catch (error) {
    reportFailure(entry.name, error, ctx);
  }
}

/** Resolve a command by name or alias. */
export function findCommand(registry: readonly RegisteredCommand[], name: string): RegisteredCommand | undefined {
  const lower = name.toLowerCase();
  return registry.find(
    (candidate) => candidate.name === lower || (candidate.aliases ?? []).includes(lower),
  );
}

/** Names of all registered commands (for tests / help rendering). */
export function slashCommandNames(registry: readonly RegisteredCommand[]): string[] {
  return registry.map((entry) => entry.name);
}

// Re-exported for screens that need shared helpers without extra imports.
export { createCodingTools, loadConfig };
export { connectCommand, testCommand, VERSION };
