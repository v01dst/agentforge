import { connectCommand, testCommand } from '../../commands.js';
import { loadConfig } from '../../config.js';
import { createCodingTools } from '../../coding-tools.js';
import { currentPermissionMode } from '../../permissions-state.js';
import { listSkills } from '../../skills/skills.js';

export type SlashAction = (args: string[]) => void | Promise<void>;

export interface SlashEntry {
  name: string;
  description: string;
  usage?: string;
  action: SlashAction;
  interactive?: boolean;
}

export type SlashScreen =
  | 'tools'
  | 'workflows'
  | 'agents'
  | 'runs'
  | 'settings'
  | 'models'
  | 'help'
  | 'doctor-result'
  | 'new-project'
  | 'run'
  | 'inspect';

export interface SlashHandlers {
  openScreen: (screen: SlashScreen, arg?: string) => void;
  /** Unmount ink -> run fn -> wait Enter -> remount; console output is safe inside. */
  runSuspended: (fn: () => Promise<number>) => Promise<void>;
  pushSystem: (text: string) => void;
  clearConversation: () => void;
  exitRequested: () => void;
}

/** Normalize raw input ("/model x") to a command name + args, or null for non-commands. */
export function parseSlashInput(input: string): { name: string; args: string[] } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/') || trimmed.length < 2) return null;
  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return { name: parts[0]!, args: parts.slice(1) };
}

function describeEntry(entry: string | { name: string; description?: string }): string {
  return typeof entry === 'string' ? entry : `${entry.name}${entry.description ? ` — ${entry.description}` : ''}`;
}

export function buildSlashRegistry(handlers: SlashHandlers): SlashEntry[] {
  const entries: SlashEntry[] = [
    {
      name: 'help',
      description: 'Show help overlay',
      action: () => handlers.openScreen('help'),
    },
    {
      name: 'connect',
      description: 'Connect a provider (credentials stored in OS keychain)',
      usage: '/connect <provider>',
      action: (args) => handlers.runSuspended(() => connectCommand(args[0], { 'no-prompt': true })),
    },
    {
      name: 'providers',
      description: 'Open the Models & Providers manager',
      action: () => handlers.openScreen('models'),
    },
    {
      name: 'models',
      description: 'Open the Models & Providers manager',
      action: () => handlers.openScreen('models'),
    },
    {
      name: 'model',
      description: 'Show or set the session model',
      usage: '/model [name]',
      action: (args) => {
        const name = args[0];
        if (!name) {
          handlers.pushSystem(`Current model: ${process.env.AGENTFORGE_MODEL ?? '(unset)'}`);
          return;
        }
        process.env.AGENTFORGE_MODEL = name;
        handlers.pushSystem(`Model set to ${name}`);
      },
    },
    {
      name: 'tools',
      description: 'Browse configured and built-in tools',
      action: () => handlers.openScreen('tools'),
    },
    {
      name: 'skills',
      description: 'List project skills (.agentforge/skills)',
      interactive: true,
      action: async () => {
        await handlers.runSuspended(async () => {
          const skills = await listSkills();
          if (!skills.length) {
            console.log('(no skills found — add markdown files under .agentforge/skills/)');
            return 0;
          }
          console.log(`Skills (${skills.length}):`);
          for (const skill of skills) {
            console.log(`  ${skill.name}${skill.description ? ` — ${skill.description}` : ''}`);
          }
          return 0;
        });
      },
    },
    {
      name: 'agents',
      description: 'Pick an agent entry to run',
      action: () => handlers.openScreen('run'),
    },
    {
      name: 'workflows',
      description: 'Browse and run workflows',
      action: () => handlers.openScreen('workflows'),
    },
    {
      name: 'runs',
      description: 'Browse recent runs',
      action: () => handlers.openScreen('runs'),
    },
    {
      name: 'inspect',
      description: 'Inspect a run by id',
      usage: '/inspect <id>',
      action: (args) => {
        const id = args[0];
        if (!id) {
          handlers.pushSystem('Usage: /inspect <id>');
          return;
        }
        handlers.openScreen('inspect', id);
      },
    },
    {
      name: 'test',
      description: 'Run the project test suite',
      interactive: true,
      action: () => handlers.runSuspended(() => testCommand([])),
    },
    {
      name: 'doctor',
      description: 'Show environment doctor results',
      action: () => handlers.openScreen('doctor-result'),
    },
    {
      name: 'config',
      description: 'Open session settings',
      action: () => handlers.openScreen('settings'),
    },
    {
      name: 'settings',
      description: 'Open session settings',
      action: () => handlers.openScreen('settings'),
    },
    {
      name: 'clear',
      description: 'Clear the conversation',
      action: () => handlers.clearConversation(),
    },
    {
      name: 'status',
      description: 'Show session status summary',
      action: () => {
        void (async () => {
          let provider = process.env.AGENTFORGE_PROVIDER ?? '(default)';
          let entry: string | undefined;
          try {
            const { config } = await loadConfig({ required: false });
            provider = process.env.AGENTFORGE_PROVIDER ?? config.provider ?? provider;
            entry = config.entry ?? (config as { entry?: string }).entry;
          } catch {
            /* fall back to env-only summary */
          }
          const lines = [
            `provider: ${provider}`,
            `model: ${process.env.AGENTFORGE_MODEL ?? '(unset)'}`,
            `permission mode: ${currentPermissionMode()}`,
            `cwd: ${process.cwd()}`,
            `project entry: ${entry ?? '(not set)'}`,
          ];
          handlers.pushSystem(lines.join('\n'));
        })();
      },
    },
    {
      name: 'init',
      description: 'Initialize / scaffold a new project',
      action: () => handlers.openScreen('new-project'),
    },
    {
      name: 'new',
      description: 'Create a new project',
      action: () => handlers.openScreen('new-project'),
    },
    {
      name: 'project',
      description: 'New project setup',
      action: () => handlers.openScreen('new-project'),
    },
    {
      name: 'chat',
      description: 'Return to chat',
      action: () => handlers.pushSystem('You are already in the chat.'),
    },
    {
      name: 'exit',
      description: 'Exit AgentForge',
      action: () => handlers.exitRequested(),
    },
  ];
  return entries;
}

/** Dispatch parsed input against the registry; returns false when unknown. */
export function dispatchSlash(
  registry: readonly SlashEntry[],
  input: string,
  pushSystem: (text: string) => void,
): boolean {
  const parsed = parseSlashInput(input);
  if (!parsed) return false;
  const entry = registry.find((candidate) => candidate.name === parsed.name);
  if (!entry) {
    pushSystem(`Unknown command: /${parsed.name} — try /help`);
    return true;
  }
  void entry.action(parsed.args);
  return true;
}

/** Names of all registered commands (for tests / help rendering). */
export function slashCommandNames(registry: readonly SlashEntry[]): string[] {
  return registry.map((entry) => entry.name);
}

// Re-exported for screens that need shared helpers without extra imports.
export { describeEntry, createCodingTools, loadConfig, listSkills };
