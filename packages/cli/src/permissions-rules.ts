import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Permission-rule matching (Phase G). Rules become structured matchers:
 *
 * - Tool names stay exact or `*`; dots create implicit hierarchy:
 *   a rule for `mcp.server` covers `mcp.server.tool`.
 * - Globs (`*`, `mcp.*`, `**`) match tool names by segment.
 * - `run_command:prefix` / `run_command:prefix=git status` restrict rules
 *   to matching command lines (deny wins over allow on overlap).
 * - `external_directory:<path>` grants read access outside the workspace.
 */

export interface PermissionRule {
  /** Tool name, glob (`mcp.*`, `**`), the global `*`, or `tool:qualifier`. */
  tool: string;
  action: 'allow' | 'deny';
}

/** A `run_command` invocation parsed for rule evaluation. */
export interface CommandContext {
  /** The program name (argv[0]). */
  command: string;
  /** Remaining argv. */
  args?: readonly string[];
}

export interface RuleEvaluationInput {
  tool: string;
  command?: CommandContext;
}

/** Internal: how precisely a rule matches an invocation. */
interface RuleMatch {
  verdict: 'allow' | 'deny';
  /** Higher wins. deny beats allow at equal specificity. */
  specificity: number;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

function matchesPattern(pattern: string, tool: string): boolean {
  if (pattern === tool) return true;
  if (!pattern.includes('*')) return false;
  return globToRegExp(pattern).test(tool);
}

/** Dotted hierarchy: `mcp.server` rule covers `mcp.server.tool`. */
function coversByHierarchy(pattern: string, tool: string): boolean {
  if (!pattern.includes('.')) return false;
  return tool === pattern || tool.startsWith(`${pattern}.`);
}

function commandLine(context: CommandContext): string {
  return [context.command, ...(context.args ?? [])].join(' ').trim();
}

function matchesCommandQualifier(qualifier: string, context: CommandContext | undefined): boolean {
  if (!context) return false;
  const line = commandLine(context);
  const value = qualifier.startsWith('prefix=')
    ? qualifier.slice('prefix='.length).trim()
    : qualifier;
  return line === value || line.startsWith(`${value} `);
}

/** Parsed rule target: plain tool pattern, command prefix, or external dir. */
type ParsedRule =
  | { kind: 'pattern'; pattern: string }
  | { kind: 'prefix'; tool: string; prefix: string }
  | { kind: 'external'; path: string };

/** Classify `tool`, `tool:prefix[=…]`, or `external_directory:<path>`. */
function parseRuleTarget(ruleTool: string): ParsedRule {
  if (ruleTool.startsWith('external_directory:')) {
    return { kind: 'external', path: ruleTool.slice('external_directory:'.length).trim() };
  }
  const colon = ruleTool.indexOf(':prefix');
  if (colon > 0) {
    const tool = ruleTool.slice(0, colon);
    let prefix = ruleTool.slice(colon + ':prefix'.length);
    if (prefix.startsWith('=')) prefix = prefix.slice(1);
    return { kind: 'prefix', tool, prefix: prefix.trim() };
  }
  return { kind: 'pattern', pattern: ruleTool };
}

/**
 * Evaluate the structured rule set for one invocation.
 * Most specific match wins (prefix > exact > hierarchy > glob > `*`);
 * deny beats allow at equal specificity.
 */
export function evaluateInvocationRules(
  rules: readonly PermissionRule[],
  input: RuleEvaluationInput,
): 'allow' | 'deny' | undefined {
  let verdict: 'allow' | 'deny' | undefined;
  let specificity = -1;
  const consider = (match: RuleMatch | undefined): void => {
    if (!match) return;
    if (match.specificity < specificity) return;
    if (match.specificity === specificity && verdict === 'deny') return;
    verdict = match.verdict;
    specificity = match.specificity;
  };

  for (const rule of rules) {
    const target = parseRuleTarget(rule.tool);

    if (target.kind === 'external') continue; // handled by path checks
    if (target.kind === 'prefix') {
      if (target.tool !== input.tool || !input.command) continue;
      if (!matchesCommandQualifier(target.prefix, input.command)) continue;
      consider({ verdict: rule.action, specificity: 4 });
      continue;
    }

    const pattern = target.pattern;
    if (!matchesPattern(pattern, input.tool) && !coversByHierarchy(pattern, input.tool)) {
      continue;
    }
    const ruleSpecificity = pattern === '*'
      ? 0
      : pattern.includes('*')
        ? 1
        : pattern.includes('.')
          ? 2
          : 3;
    consider({ verdict: rule.action, specificity: ruleSpecificity });
  }
  return verdict;
}

/**
 * Backward-compatible per-tool evaluation (no command context): delegates to
 * the structured evaluator so glob/hierarchy rules work everywhere.
 */
export function evaluateRules(rules: readonly PermissionRule[], tool: string): 'allow' | 'deny' | undefined {
  return evaluateInvocationRules(rules, { tool });
}

// ---------------------------------------------------------------------------
// external_directory rules (Phase G)
// ---------------------------------------------------------------------------

/** Resolve `external_directory` grants from rules (absolute paths). */
export function externalDirectories(rules: readonly PermissionRule[], root: string): string[] {
  const dirs: string[] = [];
  for (const rule of rules) {
    const target = parseRuleTarget(rule.tool);
    if (target.kind !== 'external') continue;
    if (rule.action !== 'allow') continue;
    dirs.push(isAbsolute(target.path) ? target.path : resolve(root, target.path));
  }
  return dirs;
}

export function isPathAllowed(root: string, candidate: string, externalDirs: readonly string[]): boolean {
  // Resolve relative candidates against the workspace root (never the cwd)
  // so `..` escapes are still detected; only then consider external grants.
  const full = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  if (withinRoot(root, full)) return true;
  return externalDirs.some((dir) => withinRoot(dir, full));
}

function withinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
