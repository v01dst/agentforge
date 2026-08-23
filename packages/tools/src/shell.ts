import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { defineTool } from './tool.js';
const runFile = promisify(execFile);

export interface ShellToolOptions { enabled: true; allowedCommands: string[]; cwd?: string; timeoutMs?: number; maxBuffer?: number; env?: Record<string, string>; }
export function createShellTool(options: ShellToolOptions) {
  if (!options.enabled || !options.allowedCommands.length) throw new Error('Shell tool requires enabled: true and a non-empty command allowlist');
  return defineTool({ name: 'shell_command', description: 'Execute an allowlisted program without a shell. This capability must be explicitly enabled.', permissions: ['process:execute'], timeoutMs: options.timeoutMs ?? 10_000,
    input: z.object({ command: z.string(), args: z.array(z.string()).default([]) }), output: z.object({ stdout: z.string(), stderr: z.string(), command: z.string(), exitCode: z.number() }),
    async execute({ command, args }) { if (!options.allowedCommands.includes(command)) throw new Error(`Command ${command} is not allowlisted`); try { const result = await runFile(command, args, { cwd: options.cwd, timeout: options.timeoutMs ?? 10_000, maxBuffer: options.maxBuffer ?? 1_000_000, env: options.env ? { ...process.env, ...options.env } : process.env }); return { stdout: result.stdout, stderr: result.stderr, command, exitCode: 0 }; } catch (error) { const value = error as Error & { stdout?: string; stderr?: string; code?: number }; throw new Error(`Command failed (${value.code ?? 'unknown'}): ${value.stderr ?? value.message}`); } },
  });
}
