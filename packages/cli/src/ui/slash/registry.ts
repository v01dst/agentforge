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
      description: 'Providers manager — /providers add|remove|test <name>, or open the manager screen',
      usage: '/providers [add|remove|test] [name]',
      argsHint: ['action', 'name'],
      category: 'config',
      run: async (args, cmdCtx) => {
        const [action, name] = args;
        if (!action) {
          ctx.openScreen('models');
          return;
        }
        if (action === 'add') {
          // EzStart-style guided add, inline: name → preset or custom.
          await ctx.runSuspended(() => cliCommands.providers(['add', ...args.slice(1)]));
          cmdCtx.pushSystem('provider saved — /models or /providers lists it; keys live in ~/.agentforge/credentials.json');
          return;
        }
        if (action === 'remove' || action === 'test') {
          await ctx.runSuspended(() => cliCommands.providers(args));
          cmdCtx.pushSystem(`provider ${action} done`);
          return;
        }
        if (!name) {
          cmdCtx.pushSystem('usage: /providers add <name> --base-url <url> --model <id> [--api-key-env VAR] · /providers remove <name> · /providers test <name>');
          return;
        }
      },
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
      description: 'List project + global skills — /skills approve|reject|diff for staged writes',
      usage: '/skills [name | pending|approve|reject|diff [id]]',
      category: 'resources',
      run: async (args, cmdCtx) => {
        const first = args[0];
        if (!first) {
          ctx.openScreen('skills');
          return;
        }
        if (['pending', 'approve', 'reject', 'diff'].includes(first)) {
          await ctx.runSuspended(() => cliCommands.skillsAdmin(['skills', ...args]));
          cmdCtx.pushSystem('skill review done — staged writes landed or were rejected');
          return;
        }
        // Toggle behavior for a named skill stays inline (fast path).
        await ctx.runSuspended(() => cliCommands.skillsAdmin(['skills', ...args]));
        cmdCtx.pushSystem(`skill command done for '${first}'`);
      },
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
      name: 'mode',
      description: 'Show or set the session mode (chat | build | indie | automode)',
      usage: '/mode [chat|build|indie|automode]',
      argsHint: ['mode'],
      category: 'config',
      run: async (args, cmdCtx) => {
        const { SESSION_MODES, SESSION_MODE_DEFINITIONS, currentSessionMode, enterSessionMode, isSessionMode } = await import('../../modes/session-modes.js');
        const target = args[0];
        if (!target) {
          const current = currentSessionMode();
          cmdCtx.pushSystem([
            `session mode: ${current}`,
            ...SESSION_MODES.map((mode) => `  ${mode}${mode === current ? ' ←' : ''} — ${SESSION_MODE_DEFINITIONS[mode].description}`),
          ].join('\n'));
          return;
        }
        if (!isSessionMode(target)) {
          cmdCtx.pushSystem(`✗ unknown session mode '${target}' — modes: ${SESSION_MODES.join(' | ')}`);
          return;
        }
        const result = enterSessionMode(target);
        cmdCtx.refreshStatus();
        cmdCtx.pushSystem(`session mode: ${result.mode} (posture: ${result.postureApplied})`);
      },
    },
    {
      name: 'permissions',
      aliases: ['posture'],
      description: 'Show or set the permission posture for coding tools',
      usage: '/permissions [read-only|ask|workspace-write|trusted]',
      argsHint: ['posture'],
      category: 'config',
      run: async (args, cmdCtx) => {
        const { PERMISSION_MODES, currentPermissionMode, setPermissionMode } = await import('../../permissions.js');
        const target = args[0];
        if (!target) {
          cmdCtx.pushSystem(`permission posture: ${currentPermissionMode()} — postures: ${PERMISSION_MODES.join(' | ')}`);
          return;
        }
        if (!(PERMISSION_MODES as readonly string[]).includes(target)) {
          cmdCtx.pushSystem(`✗ unknown posture '${target}' — postures: ${PERMISSION_MODES.join(', ')}`);
          return;
        }
        setPermissionMode(target as never);
        cmdCtx.refreshStatus();
        cmdCtx.pushSystem(`permission posture: ${target}`);
      },
    },
    {
      name: 'plan',
      description: 'Switch to plan mode: read-only posture for exploration and planning',
      usage: '/plan',
      category: 'config',
      run: async (_args, cmdCtx) => {
        const { setPermissionMode } = await import('../../permissions.js');
        setPermissionMode('read-only');
        cmdCtx.refreshStatus();
        cmdCtx.pushSystem('plan mode: read-only posture — explore and design, edits and commands will be declined');
      },
    },
    {
      name: 'build',
      description: 'Switch to build mode: workspace-write posture for implementation',
      usage: '/build',
      category: 'config',
      run: async (_args, cmdCtx) => {
        const { setPermissionMode } = await import('../../permissions.js');
        setPermissionMode('workspace-write');
        cmdCtx.refreshStatus();
        cmdCtx.pushSystem('build mode: workspace-write posture — edits allowed in the workspace');
      },
    },
    {
      name: 'profile',
      description: 'Apply a saved profile, or save the current session as one: /profile save <name>',
      usage: '/profile [name | save <name> --provider <p> --model <m> --mode <posture>]',
      argsHint: ['name or save'],
      category: 'config',
      run: async (args, cmdCtx) => {
        const { listProfiles, getProfile, activeProfileName, setActiveProfile, resolveProfileToEnvValues } = await import('../../profiles/profiles.js');
        const name = args[0];
        if (name === 'save') {
          const { saveProfile } = await import('../../profiles/profiles.js');
          const saveName = args[1];
          if (!saveName) { cmdCtx.pushSystem('usage: /profile save <name> [--provider <p>] [--model <m>] [--mode <posture>]'); return; }
          const provider = args.includes('--provider') ? args[args.indexOf('--provider') + 1] : undefined;
          const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : undefined;
          const mode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : undefined;
          await saveProfile({ name: saveName, provider, model, permissionMode: mode as never });
          cmdCtx.pushSystem(`profile '${saveName}' saved — /profile ${saveName} activates it`);
          return;
        }
        if (!name) {
          const [profiles, active] = await Promise.all([listProfiles(), activeProfileName()]);
          if (!profiles.length) { cmdCtx.pushSystem('no profiles saved — /profile save <name> creates one from the current session'); return; }
          cmdCtx.pushSystem(['profiles:', ...profiles.map((profile) => `  ${profile.name}${profile.name === active ? ' [active]' : ''}  ${[profile.provider, profile.model].filter(Boolean).join('/') || '(session defaults)'}${profile.permissionMode ? ` · ${profile.permissionMode}` : ''}`)].join('\n'));
          return;
        }
        const profile = await getProfile(name);
        if (!profile) { cmdCtx.pushSystem(`✗ unknown profile '${name}'`); return; }
        const values = resolveProfileToEnvValues(profile);
        if (values.provider) process.env.AGENTFORGE_PROVIDER = values.provider;
        if (values.model) process.env.AGENTFORGE_MODEL = values.model;
        if (values.permissionMode) {
          const { setPermissionMode } = await import('../../permissions.js');
          setPermissionMode(values.permissionMode);
        }
        await setActiveProfile(name, 'global');
        cmdCtx.refreshStatus();
        cmdCtx.pushSystem(`profile '${name}' active: ${[values.provider, values.model].filter(Boolean).join('/') || '(session defaults)'}${values.permissionMode ? ` · ${values.permissionMode}` : ''}`);
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
      name: 'permissions',
      description: 'Posture (read-only|ask|workspace-write|trusted) or rule management: /permissions allow|deny|remove <tool>',
      usage: '/permissions [posture | allow|deny|remove <tool>]',
      aliases: ['posture'],
      argsHint: ['posture or rule action'],
      category: 'config',
      run: async (args, cmdCtx) => {
        const first = args[0];
        const { PERMISSION_MODES, currentPermissionMode, setPermissionMode } = await import('../../permissions.js');
        if (!first) {
          cmdCtx.pushSystem(`permission posture: ${currentPermissionMode()} — postures: ${PERMISSION_MODES.join(' | ')} · rule management: /permissions allow|deny|remove <tool>`);
          return;
        }
        if (PERMISSION_MODES.includes(first as never)) {
          setPermissionMode(first as never);
          cmdCtx.refreshStatus();
          cmdCtx.pushSystem(`permission posture: ${first}`);
          return;
        }
        // Rule management: delegate to the CLI implementation.
        await ctx.runSuspended(() => cliCommands.permissions(args));
        cmdCtx.pushSystem('permission rules updated — see .agentforge/permissions.json');
      },
    },
    {
      name: 'skills-admin',
      description: 'Skill review flow: pending staged writes, diff, approve, reject',
      usage: '/skills-admin [pending|diff|approve|reject] [id]',
      aliases: ['skillreview'],
      argsHint: ['action', 'id'],
      category: 'resources',
      run: async (args, cmdCtx) => {
        const action = args[0] ?? 'pending';
        await ctx.runSuspended(() => cliCommands.skillsAdmin([action, ...args.slice(1)]));
        cmdCtx.pushSystem('skill review done — /skills refreshes the list');
      },
    },
    {
      name: 'mcp',
      description: 'MCP servers: list, add, remove, tools',
      usage: '/mcp [list|add|remove|tools] …',
      argsHint: ['action'],
      category: 'resources',
      run: async (args, cmdCtx) => {
        await ctx.runSuspended(() => cliCommands.mcp(args.length ? args : ['list']));
        cmdCtx.pushSystem('mcp command done — /tools shows adapted tools');
      },
    },
    {
      name: 'findings',
      description: 'Observe-only security findings from tool activity',
      usage: '/findings [list|clear]',
      category: 'system',
      run: async (args, cmdCtx) => {
        await ctx.runSuspended(() => cliCommands.findings(args.length ? args : ['list']));
        cmdCtx.pushSystem('findings view closed — findings never gate execution');
      },
    },
    {
      name: 'benchmarks',
      description: 'Deterministic benchmarks: list, run, results',
      usage: '/benchmarks [list|run <id>|results]',
      argsHint: ['action', 'id'],
      category: 'system',
      run: async (args, cmdCtx) => {
        await ctx.runSuspended(() => cliCommands.benchmarks(args.length ? args : ['list']));
        cmdCtx.pushSystem('benchmarks view closed — results in .agentforge/benchmarks/');
      },
    },
    {
      name: 'gateway',
      description: 'Serve an OpenAI-compatible endpoint over this agent (blocks until Ctrl-C)',
      usage: '/gateway serve [--port <n>]',
      argsHint: ['serve'],
      category: 'system',
      run: async (args, cmdCtx) => {
        await ctx.runSuspended(() => cliCommands.gateway(args.length ? args : ['serve']));
        cmdCtx.pushSystem('gateway stopped');
      },
    },
    {
      name: 'daemon',
      description: 'Heartbeat daemon: run (blocks), status, stop, install',
      usage: '/daemon [run|status|stop|install]',
      argsHint: ['action'],
      category: 'system',
      run: async (args, cmdCtx) => {
        await ctx.runSuspended(() => cliCommands.daemon(args.length ? args : ['status']));
        cmdCtx.pushSystem('daemon command done');
      },
    },
    {
      name: 'sessions-admin',
      description: 'Session maintenance: export, prune, delete',
      usage: '/sessions-admin [export|prune|delete] …',
      argsHint: ['action'],
      category: 'project',
      run: async (args, cmdCtx) => {
        if (!args.length) {
          cmdCtx.pushSystem('usage: /sessions-admin export <id> [--format md|json] · prune --older-than-days <n> · delete <id>');
          return;
        }
        await ctx.runSuspended(() => cliCommands.sessions(args));
        cmdCtx.pushSystem('sessions command done');
      },
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
      run: async (args) => {
        const target = args[0] ? (args[0].startsWith('~') ? joinHome(args[0]) : args[0]) : homedir();
        let resolved: string;
        try {
          resolved = resolvePath(process.cwd(), target);
          process.chdir(resolved);
        } catch (error) {
          ctx.pushSystem(`✗ /cd failed: ${(error as Error).message}`);
          return;
        }
        // Await the bookkeeping so dispatch observes the note deterministically.
        await addRecentProject(resolved);
        const project = await detectProject(resolved);
        ctx.pushSystem([
          `cwd → ${resolved}`,
          `project: ${project.found ? project.path : 'none — session mode'}`,
          `recent projects: see ~/.agentforge/config.json`,
        ].join('\n'));
        ctx.refreshStatus();
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

/**
 * Command metadata for cheat-sheet views (0.8 X): the live registry built
 * with no-op handlers, projected to name/description/usage/category.
 */
export interface CommandCatalogEntry {
  name: string;
  description: string;
  usage?: string;
  aliases?: readonly string[];
  category: 'session' | 'config' | 'resources' | 'project' | 'system';
}

export function commandCatalog(): CommandCatalogEntry[] {
  const noop = (): void => {};
  const handlers: SlashHandlers = {
    openScreen: noop,
    runSuspended: (async (fn: () => Promise<number>) => { await fn(); }) as unknown as () => Promise<void>,
    pushSystem: noop,
    clearConversation: noop,
    exitRequested: noop,
    mode: () => 'project',
  };
  return buildSlashRegistry(handlers).map((entry) => ({
    name: entry.name,
    description: entry.description,
    usage: entry.usage,
    aliases: entry.aliases,
    category: entry.category,
  }));
}

/** Lazy import map for CLI command implementations used by slash passthroughs (0.8 T). */
const cliCommands = {
  providers: (args: string[]): Promise<number> => import('../../commands.js').then((m) => m.providersCommand(args, {})),
  permissions: (args: string[]): Promise<number> => import('../../commands.js').then((m) => m.permissionsCommand(args, {})),
  skillsAdmin: (args: string[]): Promise<number> => import('../../commands.js').then((m) => m.skillsCommand(args, {})),
  mcp: (args: string[]): Promise<number> => import('../../commands.js').then((m) => m.mcpCommand(args, {})),
  findings: (args: string[]): Promise<number> => import('../../commands.js').then((m) => m.findingsCommand(args, {})),
  benchmarks: (args: string[]): Promise<number> => import('../../commands.js').then((m) => m.benchmarksCommand(args, {})),
  gateway: (args: string[]): Promise<number> => import('../../commands.js').then((m) => m.gatewayCommand(args, {})),
  daemon: (args: string[]): Promise<number> => import('../../commands.js').then((m) => m.daemonCommand(args, {})),
  sessions: (args: string[]): Promise<number> => import('../../commands.js').then((m) => m.sessionsCommand(args, {})),
} as const;
