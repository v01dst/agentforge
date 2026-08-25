import { access, constants } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { TurnRunner } from './ui/turn.js';

/** Result of scanning upward from a directory for a project config. */
export interface ProjectDetection {
  found: boolean;
  /** Directory containing the discovered config. */
  path?: string;
  /** Full path to agentforge.config.* when found. */
  configPath?: string;
}

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

/** Pure upward search for agentforge.config.* — detection only, never throws or imports. */
export async function detectProject(cwd = process.cwd()): Promise<ProjectDetection> {
  let current = resolve(cwd);
  while (true) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(current, name);
      if (await exists(candidate)) return { found: true, path: current, configPath: candidate };
    }
    const parent = dirname(current);
    if (parent === current) return { found: false };
    current = parent;
  }
}

export interface BareRunnerOptions {
  /**
   * Optional real model runner to delegate to once wired up. When absent,
   * inputs receive a deterministic guidance response (no network).
   */
  runner?: TurnRunner;
}

const GUIDANCE_HEADER = '[AgentForge guidance — deterministic session-mode help, not AI output]';
const SESSION_COMMANDS = [
  '/connect — register or select a model provider endpoint',
  '/models — list available models across providers',
  '/tools — inspect available tools',
  '/skills — browse installed skills',
  '/new — start a fresh session',
  '/cd — change the working directory (e.g. into a project)',
].map((line) => `  ${line}`).join('\n');

/**
 * TurnRunner-compatible factory used when NO project exists: any normal text
 * input yields a fixed explanation of session mode and what works. If a real
 * runner is injected later, it takes over entirely.
 */
export function createBareRunner(options: BareRunnerOptions = {}): TurnRunner {
  return async function* runBareTurn(input, signal, context) {
    if (options.runner) {
      yield* options.runner(input, signal, context);
      return;
    }
    void signal;
    yield {
      text: [
        GUIDANCE_HEADER,
        '',
        `You are in session mode (no agentforge.config.* found above ${resolve(process.cwd())}), so there is no project agent to run.`,
        'Everything still works from here:',
        SESSION_COMMANDS,
        '',
        'Run `agentforge init <name>` to scaffold a project, then /cd into it.',
      ].join('\n'),
    };
  };
}
