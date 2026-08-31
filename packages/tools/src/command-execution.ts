import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { defineTool } from './tool.js';

const runFile = promisify(execFile);

const DEFAULT_BLOCKED_PATTERNS: RegExp[] = [
  /\brm\s+(?:-{1,2}[\w-]+\s+)*-?[rf][\w-]*\s+\/(?:\s|$)/,
  /\brm\s+(?:-{1,2}[\w-]+\s+)*-?[rf][\w-]*\s+(?:~|\*|\.|\.\.|\$HOME)(?:\s|$)/,
  /\bsudo\b/,
  /^(?:sudo\s+)*su\s+/,
  /\bchmod\s+(?:-{1,2}[\w-]+\s+)*777\s+\//,
  /\bchown\s+(?:-{1,2}[\w-]+\s+)*\S+\s+\//,
  /\bmkfs(?:\.\w+)?\b/,
  /\bwipefs\b/,
  /\bdd\s+if=\/dev\//,
  /\bdd\s+of=\/dev\//,
  /^(?:sudo\s+)*(?:shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/,
  /:\(\)\s*\{\s*:\|:&\s*;?\s*\}\s*;?\s*:/,
  /\bcurl\b[^&|;]*\|\s*(?:ba)?sh\b/,
  /\bwget\b[^&|;]*\|\s*(?:ba)?sh\b/,
];

const SHELL_METACHARACTERS = [';', '&&', '|', '`', '$(', '>', '<'];

export class CommandBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandBlockedError';
  }
}

export class CommandTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandTimeoutError';
  }
}

interface SafeExecOptions {
  cwd: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

interface SafeExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/** Shared no-shell execFile used by every command-execution tool in this module. */
async function safeExecFile(command: string, args: string[], options: SafeExecOptions): Promise<SafeExecResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const startedAt = Date.now();
  try {
    const result = await runFile(command, args, {
      cwd: options.cwd,
      timeout: timeoutMs,
      maxBuffer: options.maxBuffer ?? 1_000_000,
      windowsHide: true,
      shell: false,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: (result as unknown as { exitCode?: number }).exitCode ?? 0,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const value = error as NodeJS.ErrnoException & {
      code?: string | number;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
    };
    const durationMs = Date.now() - startedAt;
    if (value.killed || value.signal || value.code === 'ETIMEDOUT') {
      throw new CommandTimeoutError(`Command timed out after ${timeoutMs}ms`);
    }
    if (typeof value.code === 'number') {
      return { stdout: value.stdout ?? '', stderr: value.stderr ?? '', exitCode: value.code, durationMs };
    }
    throw new Error(`Failed to spawn ${command}: ${value.message}`);
  }
}

/** Absolute paths an allowlisted program may still reference from outside the workspace. */
const SAFE_ABSOLUTE_PATHS = new Set(['/dev/null']);

/**
 * Rejects path-like arguments that resolve outside the workspace root:
 * absolute paths, `..` escapes, and `--flag=<path>` values. Without a shell,
 * reading or writing outside the root requires the program itself to receive
 * such a path — so this closes the `cat /etc/passwd` class of exfiltration.
 */
function assertArgsStayInWorkspace(args: string[], root: string): void {
  for (const arg of args) {
    const candidate = /^--?[^=]+=/.test(arg) ? arg.slice(arg.indexOf('=') + 1) : arg;
    if (!candidate) continue;
    const pathLike = isAbsolute(candidate) || candidate === '~' || candidate.startsWith('~/') || candidate === '.' || candidate === '..' || candidate.startsWith('./') || candidate.startsWith('../');
    if (!pathLike) continue;
    // `~` points at the user's home, always outside the workspace.
    if (candidate === '~' || candidate.startsWith('~/')) {
      throw new CommandBlockedError(`Path argument '${candidate}' resolves outside the workspace root (${root})`);
    }
    const expanded = resolve(root, candidate);
    if (SAFE_ABSOLUTE_PATHS.has(expanded)) continue;
    const rel = relative(root, expanded);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new CommandBlockedError(`Path argument '${candidate}' resolves outside the workspace root (${root})`);
    }
  }
}

function assertCommandLineSafe(command: string, args: string[], allowedCommands: string[], blockedPatterns: RegExp[]): void {
  if (!allowedCommands.includes(command)) {
    throw new CommandBlockedError(`Command ${command} is not allowlisted`);
  }
  for (const arg of args) {
    for (const metacharacter of SHELL_METACHARACTERS) {
      if (arg.includes(metacharacter)) {
        throw new CommandBlockedError(`Argument contains shell metacharacter '${metacharacter}'`);
      }
    }
  }
  const commandLine = [command, ...args].join(' ');
  for (const pattern of blockedPatterns) {
    if (pattern.test(commandLine)) {
      throw new CommandBlockedError(`Command line matches a blocked pattern`);
    }
  }
}

export interface RunCommandToolOptions {
  root: string;
  allowedCommands: string[];
  blockedPatterns?: RegExp[];
  /** Reject path-like arguments resolving outside the workspace root. Default true. */
  restrictPathArgs?: boolean;
  timeoutMs?: number;
  maxBuffer?: number;
}

export function createRunCommandTool(options: RunCommandToolOptions) {
  const root = resolve(options.root);
  const blockedPatterns = options.blockedPatterns ?? DEFAULT_BLOCKED_PATTERNS;
  const restrictPathArgs = options.restrictPathArgs ?? true;
  return defineTool({
    name: 'run_command',
    description: 'Execute an allowlisted program inside the workspace root without a shell. Path arguments must stay inside the workspace.',
    permissions: ['process:execute'],
    timeoutMs: options.timeoutMs ?? 120_000,
    input: z.object({ command: z.string(), args: z.array(z.string()).default([]) }),
    output: z.object({
      stdout: z.string(),
      stderr: z.string(),
      command: z.string(),
      exitCode: z.number(),
      durationMs: z.number(),
    }),
    async execute(input) {
      const args = input.args ?? [];
      assertCommandLineSafe(input.command, args, options.allowedCommands, blockedPatterns);
      if (restrictPathArgs) assertArgsStayInWorkspace(args, root);
      const result = await safeExecFile(input.command, args, {
        cwd: root,
        timeoutMs: options.timeoutMs,
        maxBuffer: options.maxBuffer,
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        command: input.command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      };
    },
  });
}

export interface RunTestsToolOptions {
  root: string;
  testCommand?: { command: string; args: string[] };
  timeoutMs?: number;
}

interface DiscoveredTestCommand {
  command: string;
  args: string[];
}

async function discoverTestCommand(root: string, explicit?: { command: string; args: string[] }): Promise<DiscoveredTestCommand> {
  if (explicit) return explicit;
  let scripts: Record<string, unknown> | undefined;
  try {
    const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    scripts = packageJson.scripts;
  } catch {
    // No package.json — fall back to the built-in Node test runner.
    return { command: 'node', args: ['--test'] };
  }
  if (typeof scripts?.test === 'string' && scripts.test.length > 0 && !/[;&|`><$]/.test(scripts.test)) {
    // Only accept simple single-program scripts (no chained/shell commands); split conservatively on spaces.
    const parts = scripts.test.split(' ').filter(Boolean);
    return { command: parts[0]!, args: parts.slice(1) };
  }
  return { command: 'npx', args: ['vitest', 'run'] };
}

export function createRunTestsTool(options: RunTestsToolOptions) {
  const root = resolve(options.root);
  return defineTool({
    name: 'run_tests',
    description: 'Discover and run the test suite of the workspace project via a safe no-shell execution path.',
    permissions: ['process:execute'],
    timeoutMs: options.timeoutMs ?? 120_000,
    input: z.object({ pattern: z.string().optional() }),
    output: z.object({
      command: z.string(),
      args: z.array(z.string()),
      stdout: z.string(),
      stderr: z.string(),
      exitCode: z.number(),
      passed: z.boolean(),
      durationMs: z.number(),
    }),
    async execute(input) {
      const discovered = await discoverTestCommand(root, options.testCommand);
      const args = [...discovered.args];
      if (input.pattern !== undefined && input.pattern !== '') {
        args.push(input.pattern);
      }
      const result = await safeExecFile(discovered.command, args, {
        cwd: root,
        timeoutMs: options.timeoutMs,
      });
      return {
        command: discovered.command,
        args,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        passed: result.exitCode === 0,
        durationMs: result.durationMs,
      };
    },
  });
}
