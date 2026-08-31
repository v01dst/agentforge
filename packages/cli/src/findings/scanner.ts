import { mkdir, readFile, appendFile, readdir, unlink, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AgentInterceptors, ToolCall, ToolExecutionResult } from '@agentforge-oss/core';

/**
 * Security findings (Phase R): deterministic, observe-only scanning of tool
 * activity. Doctrine: findings are recorded, never enforced — the interceptor
 * returns void from preTool (no denials), and postTool records outcome-based
 * findings. Humans read the log; the agent keeps running.
 *
 * Detectors (deterministic, no model calls):
 * - secret-shaped content in tool inputs (patch text, command lines)
 * - risky shell patterns (curl|sh, sudo rm -rf /, chmod 777 /)
 * - credential-file access attempts (read_file on .env, keys)
 * - failures that look like boundary probes (permission errors)
 *
 * Findings land in `.agentforge/observability/findings.ndjson`, one JSON
 * object per line.
 */

export type FindingSeverity = 'info' | 'low' | 'medium' | 'high';

export interface SecurityFinding {
  /** Stable detector id, e.g. `secret-in-patch`. */
  kind: string;
  severity: FindingSeverity;
  /** Tool that triggered the finding. */
  tool: string;
  summary: string;
  /** Bounded detail (arguments excerpt); secrets themselves are never echoed. */
  detail?: string;
  ts: string;
  runId?: string;
}

export const FINDINGS_FILE = 'findings.ndjson';

export function findingsPath(cwd = process.cwd()): string {
  return join(resolve(cwd), '.agentforge', 'observability', FINDINGS_FILE);
}

// ---------------------------------------------------------------------------
// Deterministic detectors
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /AKIA[0-9A-Z]{16}/, label: 'AWS access key id' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: 'embedded private key' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, label: 'GitHub token' },
  { pattern: /\bsk-[A-Za-z0-9]{20,}\b/, label: 'API key (sk-…)' },
  { pattern: /AIza[0-9A-Za-z_-]{30,}/, label: 'Google API key' },
  { pattern: /(?<=["'=[\s:])xox[baprs]-[A-Za-z0-9-]{10,}/, label: 'Slack token' },
];

const CREDENTIAL_EXTENSIONS = /\.(pem|key|p12|pfx|keystore)$/;
const CREDENTIAL_BASENAMES = new Set(['.env', '.netrc', '.git-credentials', '.htpasswd']);
const KEY_BASENAMES = /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.\w+)?$/;

/** Credential-shaped path classifier (`.env.example` and friends are exempt). */
export function isCredentialPath(path: string): boolean {
  const segments = path.split(/[\\/]/).filter(Boolean);
  if (segments.includes('.ssh')) return true;
  const base = segments[segments.length - 1] ?? path;
  if (CREDENTIAL_BASENAMES.has(base) || KEY_BASENAMES.test(base)) return true;
  if (base.startsWith('.env.') && !/\.env\.(example|sample|template)$/.test(base)) return true;
  return CREDENTIAL_EXTENSIONS.test(base);
}

export function scanToolCall(call: ToolCall): Array<Omit<SecurityFinding, 'ts' | 'runId'>> {
  const findings: Array<Omit<SecurityFinding, 'ts' | 'runId'>> = [];
  const serialized = safeSerialize(call.arguments);

  if (serialized) {
    for (const { pattern, label } of SECRET_PATTERNS) {
      if (pattern.test(serialized)) {
        findings.push({
          kind: 'secret-shaped-input',
          severity: 'high',
          tool: call.name,
          summary: `Tool input contains a secret-shaped value (${label}).`,
          detail: excerptWithoutMatches(serialized, pattern),
        });
        break; // one secret finding per call is enough signal
      }
    }
  }

  if (call.name === 'run_command') {
    const command = commandLineOf(call.arguments);
    if (/\bcurl\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/.test(command) || /\bwget\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/.test(command)) {
      findings.push({ kind: 'remote-script-execution', severity: 'high', tool: call.name, summary: 'Command pipes a remote script into a shell.', detail: command.slice(0, 200) });
    }
    if (/\bsudo\s+rm\s+-rf\s+\/(\s|$)/.test(command) || /rm\s+-rf\s+\/(\s|$)/.test(command)) {
      findings.push({ kind: 'destructive-path', severity: 'high', tool: call.name, summary: 'Command removes the filesystem root.', detail: command.slice(0, 200) });
    }
    if (/\bchmod\s+(-R\s+)?777\s+\/(\s|$)/.test(command)) {
      findings.push({ kind: 'permissive-chmod', severity: 'medium', tool: call.name, summary: 'Command grants world-writable permissions at the filesystem root.', detail: command.slice(0, 200) });
    }
  }

  if (call.name === 'read_file' || call.name === 'search_text') {
    const path = (call.arguments as { path?: unknown })?.path;
    if (typeof path === 'string' && isCredentialPath(path)) {
      findings.push({ kind: 'credential-file-access', severity: 'medium', tool: call.name, summary: 'Tool targets a credential-shaped file.', detail: path.slice(0, 200) });
    }
  }

  return findings;
}

export function scanToolResult(result: ToolExecutionResult): Array<Omit<SecurityFinding, 'ts' | 'runId'>> {
  const findings: Array<Omit<SecurityFinding, 'ts' | 'runId'>> = [];
  if (result.error) {
    const message = result.error instanceof Error ? result.error.message : String(result.error);
    if (/escapes the workspace|EACCES|permission denied|EPERM/i.test(message)) {
      findings.push({
        kind: 'boundary-probe',
        severity: 'low',
        tool: result.name,
        summary: 'Tool call was refused at a security boundary.',
        detail: message.slice(0, 200),
      });
    }
  }
  return findings;
}

function safeSerialize(args: unknown): string | undefined {
  try {
    const text = JSON.stringify(args);
    return text === undefined ? undefined : text;
  } catch {
    return undefined;
  }
}

function commandLineOf(args: unknown): string {
  const value = args as { command?: unknown; args?: unknown };
  const command = typeof value?.command === 'string' ? value.command : '';
  const rest = Array.isArray(value?.args) ? value.args.map((entry) => String(entry)) : [];
  return [command, ...rest].join(' ').trim();
}

/** Detail excerpts mask the matched secret itself. */
function excerptWithoutMatches(text: string, pattern: RegExp): string | undefined {
  const masked = text.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), '[redacted]');
  return masked.length > 8 ? masked.slice(0, 240) : undefined;
}

// ---------------------------------------------------------------------------
// Interceptor + persistence
// ---------------------------------------------------------------------------

export interface FindingsRecorder {
  record(findings: Array<Omit<SecurityFinding, 'ts' | 'runId'>>, context: { tool: string; runId?: string }): Promise<void>;
}

export class FileFindingsRecorder implements FindingsRecorder {
  constructor(private readonly cwd: string) {}

  async record(findings: Array<Omit<SecurityFinding, 'ts' | 'runId'>>, context: { tool: string; runId?: string }): Promise<void> {
    if (!findings.length) return;
    await mkdir(join(resolve(this.cwd), '.agentforge', 'observability'), { recursive: true });
    const lines = findings.map((finding) => JSON.stringify({ ...finding, ts: new Date().toISOString(), runId: context.runId } satisfies SecurityFinding));
    await appendFile(findingsPath(this.cwd), `${lines.join('\n')}\n`, 'utf8');
  }
}

export interface FindingsRuntime {
  interceptors: Pick<AgentInterceptors, 'preTool' | 'postTool'>;
}

/**
 * Findings runtime (Phase R): observe-only interceptors. preTool scans
 * inputs and ALWAYS returns void (no gating); postTool scans outcomes.
 */
export function createFindingsRuntime(options: { root?: string; recorder?: FindingsRecorder } = {}): FindingsRuntime {
  const recorder = options.recorder ?? new FileFindingsRecorder(options.root ?? process.cwd());
  return {
    interceptors: {
      preTool: [
        async (call: ToolCall) => {
          try {
            await recorder.record(scanToolCall(call), { tool: call.name });
          } catch { /* recording must never break the loop */ }
          return undefined; // observe-only: never deny
        },
      ],
      postTool: [
        async (result: ToolExecutionResult) => {
          try {
            await recorder.record(scanToolResult(result), { tool: result.name });
          } catch { /* recording must never break the loop */ }
        },
      ],
    },
  };
}

/** Read findings, newest last; corrupt lines skipped. */
export async function readFindings(cwd = process.cwd(), limit = 100): Promise<SecurityFinding[]> {
  let raw: string;
  try {
    raw = await readFile(findingsPath(cwd), 'utf8');
  } catch {
    return [];
  }
  const findings: SecurityFinding[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as SecurityFinding;
      if (typeof parsed.kind === 'string' && typeof parsed.severity === 'string' && typeof parsed.tool === 'string') {
        findings.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return findings.slice(-limit);
}

export function summarizeFindings(findings: readonly SecurityFinding[]): string {
  if (!findings.length) return 'no findings recorded';
  const bySeverity = new Map<FindingSeverity, number>();
  for (const finding of findings) bySeverity.set(finding.severity, (bySeverity.get(finding.severity) ?? 0) + 1);
  const parts = [...bySeverity.entries()].sort((a, b) => b[1] - a[1]).map(([severity, count]) => `${count} ${severity}`);
  return `${findings.length} finding(s): ${parts.join(', ')}`;
}

/** Retention: clear the findings log when everything is older than the cutoff. */
export async function clearFindings(olderThanDays: number, cwd = process.cwd()): Promise<number> {
  const findings = await readFindings(cwd, Number.MAX_SAFE_INTEGER);
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const stale = findings.filter((finding) => Date.parse(finding.ts) < cutoff);
  if (stale.length === findings.length && findings.length > 0) {
    await unlink(findingsPath(cwd)).catch(() => {});
  }
  return stale.length;
}

export async function findingsFileExists(cwd = process.cwd()): Promise<boolean> {
  try {
    await stat(findingsPath(cwd));
    return true;
  } catch {
    return false;
  }
}

export function findingsDirFor(cwd: string): string {
  return join(resolve(cwd), '.agentforge', 'observability');
}

export async function listFindingFiles(cwd = process.cwd()): Promise<string[]> {
  try {
    return (await readdir(findingsDirFor(cwd))).filter((file) => file.endsWith('.ndjson'));
  } catch {
    return [];
  }
}
