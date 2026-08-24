import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { defineTool } from './tool.js';

const runFile = promisify(execFile);

const DEFAULT_BLOCKED_PATTERNS: RegExp[] = [
  /\brm\s+(?:-{1,2}[\w-]+\s+)*-?[rf][\w-]*\s+\/(?:\s|$)/,
  /\bsudo\b/,
  /\bchmod\s+(?:-{1,2}[\w-]+\s+)*777\s+\//,
  /\bmkfs(?:\.\w+)?\b/,
  /\bdd\s+if=\/dev\//,
  /:\(\)\s*\{\s*:\|:&\s*;?\s*\}\s*;?\s*:/,
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
  timeoutMs?: number;
  maxBuffer?: number;
}

export function createRunCommandTool(options: RunCommandToolOptions) {
  const root = resolve(options.root);
  const blockedPatterns = options.blockedPatterns ?? DEFAULT_BLOCKED_PATTERNS;
  return defineTool({
    name: 'run_command',
    description: 'Execute an allowlisted program inside the workspace root without a shell.',
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
