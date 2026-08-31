import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** A per-tool permission rule persisted at project level. */
export interface PermissionRule {
  /** Tool name (e.g. `run_command`, `mcp.server.tool`) or the global `*`. */
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

/** Validate one parsed rule; throws with a human-readable message. */
export function validatePermissionRule(value: unknown): PermissionRule {
  if (!isRecord(value)) throw new Error('Permission rules must be objects.');
  const tool = typeof value.tool === 'string' ? value.tool : '';
  if (tool !== '*' && !/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/.test(tool)) {
    throw new Error(`Permission rule tool '${String(value.tool)}' must be a tool name or '*'.`);
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
 * Evaluation order: most specific rule wins; deny beats allow at equal
 * specificity; no matching rule returns undefined (mode logic decides).
 */
export function evaluateRules(rules: readonly PermissionRule[], tool: string): 'allow' | 'deny' | undefined {
  let verdict: 'allow' | 'deny' | undefined;
  let specificity = -1;
  for (const rule of rules) {
    if (rule.tool !== '*' && rule.tool !== tool) continue;
    const ruleSpecificity = rule.tool === '*' ? 0 : 1;
    if (ruleSpecificity < specificity) continue;
    verdict = rule.action;
    specificity = ruleSpecificity;
  }
  return verdict;
}

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
