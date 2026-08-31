import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** A per-tool permission rule persisted at project level. */
export interface PermissionRule {
  /**
   * Tool name (e.g. `run_command`), the global `*`, a glob (`mcp.*`, `**`),
   * a dotted hierarchy prefix (`mcp.server`), or a qualified rule:
   * `run_command:prefix=<line>` or `external_directory:<path>`.
   */
  tool: string;
  action: 'allow' | 'deny';
}

export const PERMISSIONS_DIR = '.agentforge';
export const PERMISSIONS_FILE = `${PERMISSIONS_DIR}/permissions.json`;

export function permissionsFilePath(cwd = process.cwd()): string {
  return join(resolve(cwd), PERMISSIONS_DIR, 'permissions.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Valid rule targets: plain tool names, `*`, globs, dotted hierarchy
 * prefixes, `run_command:prefix[=…]`, and `external_directory:<path>`.
 * Unknown qualifiers (e.g. `read_file:bogus`) are rejected.
 */
const RULE_TARGET = /^[a-zA-Z*][a-zA-Z0-9.*_-]{0,127}$/;
const EXTERNAL_TARGET = /^external_directory:\s*\S.*$/;
const PREFIX_TARGET = /^[a-zA-Z][a-zA-Z0-9._-]{0,127}:prefix(=\s*\S.*)?$/;

/** Validate one parsed rule; throws with a human-readable message. */
export function validatePermissionRule(value: unknown): PermissionRule {
  if (!isRecord(value)) throw new Error('Permission rules must be objects.');
  const tool = typeof value.tool === 'string' ? value.tool : '';
  const validTarget = tool === '*' || RULE_TARGET.test(tool) || EXTERNAL_TARGET.test(tool) || PREFIX_TARGET.test(tool);
  if (!validTarget) {
    throw new Error(`Permission rule tool '${String(value.tool)}' must be a tool name, glob, or qualified rule (tool:prefix=…, external_directory:<path>).`);
  }
  const actionText = typeof value.action === 'string' ? value.action : '';
  if (actionText !== 'allow' && actionText !== 'deny') {
    throw new Error(`Permission rule for '${tool}': action must be 'allow' or 'deny'.`);
  }
  return { tool, action: actionText };
}

function validatePermissionFile(parsed: unknown): PermissionRule[] {
  if (parsed === null || parsed === undefined) return [];
  if (!isRecord(parsed) || !Array.isArray(parsed.rules)) throw new Error(`${PERMISSIONS_FILE} must contain a "rules" array.`);
  return parsed.rules.map(validatePermissionRule);
}

export async function readPermissionRules(cwd = process.cwd()): Promise<PermissionRule[]> {
  try {
    return validatePermissionFile(JSON.parse(await readFile(permissionsFilePath(cwd), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Synchronous read for contexts that cannot await (runner factories).
 * Malformed files fail closed with an empty rule set plus a stderr warning;
 * a missing file is silent.
 */
export function readPermissionRulesSync(cwd = process.cwd()): PermissionRule[] {
  try {
    return validatePermissionFile(JSON.parse(readFileSync(permissionsFilePath(cwd), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    process.stderr.write(`agentforge: ignoring ${PERMISSIONS_FILE}: ${(error as Error).message}\n`);
    return [];
  }
}

export async function writePermissionRules(rules: readonly PermissionRule[], cwd = process.cwd()): Promise<void> {
  const path = permissionsFilePath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ rules }, null, 2)}\n`, 'utf8');
}

/**
 * Evaluation moved to permissions-rules.ts (Phase G): glob patterns, dotted
 * hierarchies, command prefixes, and external directories. This re-export
 * keeps the legacy per-tool entry point.
 */
export { evaluateRules, evaluateInvocationRules, externalDirectories, isPathAllowed } from './permissions-rules.js';
export type { CommandContext, RuleEvaluationInput } from './permissions-rules.js';

export async function addPermissionRule(tool: string, action: PermissionRule['action'], options: { force?: boolean } = {}, cwd = process.cwd()): Promise<{ replaced: boolean }> {
  const rules = await readPermissionRules(cwd);
  const existingIndex = rules.findIndex((rule) => rule.tool === tool);
  if (existingIndex >= 0 && !options.force) {
    throw new Error(`Rule for '${tool}' already exists in ${PERMISSIONS_FILE} (${rules[existingIndex]!.action}). Pass --force to replace it.`);
  }
  const rule = validatePermissionRule({ tool, action });
  if (existingIndex >= 0) rules[existingIndex] = rule;
  else rules.push(rule);
  await writePermissionRules(rules, cwd);
  return { replaced: existingIndex >= 0 };
}

export async function removePermissionRule(tool: string, cwd = process.cwd()): Promise<boolean> {
  const rules = await readPermissionRules(cwd);
  const next = rules.filter((rule) => rule.tool !== tool);
  if (next.length === rules.length) return false;
  await writePermissionRules(next, cwd);
  return true;
}
