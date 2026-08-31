import { relative, resolve, isAbsolute } from 'node:path';
import {
  evaluateInvocationRules,
  externalDirectories,
  isPathAllowed,
  type CommandContext,
  type PermissionRule,
} from './permissions-store.js';

/** Structural view of a core ToolLike; the CLI intentionally does not depend on @agentforge-oss/core. */
interface PolicyTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { parse(value: unknown): unknown };
  readonly permissions?: string[];
  readonly timeoutMs?: number;
  readonly retries?: number;
  execute(input: unknown, context: { runId: string; signal: AbortSignal; metadata?: Record<string, unknown> }): Promise<unknown>;
}

/**
 * Permission modes for interactive coding-agent sessions.
 *
 * - `read-only`: repository inspection only; no writes, commands, or network.
 * - `ask` (default): reads allowed in-workspace; every mutation/command asks.
 * - `workspace-write`: scoped file edits allowed; shell/network still ask.
 * - `trusted`: allow configured capabilities inside strict boundaries.
 */
export type PermissionMode = 'read-only' | 'ask' | 'workspace-write' | 'trusted';

/** Permissions each mode implicitly grants without prompting. */
export const MODE_ALLOWED_PERMISSIONS: Record<PermissionMode, ReadonlySet<string>> = {
  'read-only': new Set(['filesystem:read']),
  ask: new Set(['filesystem:read']),
  'workspace-write': new Set(['filesystem:read', 'filesystem:write']),
  trusted: new Set(['filesystem:read', 'filesystem:write', 'process:execute', 'network:request']),
};

/** Session-scoped permission mode state (defaults to 'ask'). */
let currentMode: PermissionMode = 'ask';

export const PERMISSION_MODES = ['read-only', 'ask', 'workspace-write', 'trusted'] as const;

export function currentPermissionMode(): PermissionMode {
  return currentMode;
}

export function setPermissionMode(mode: PermissionMode): void {
  currentMode = mode;
}

const WRITE_TOOLS = new Set(['apply_patch']);
const EXEC_TOOLS = new Set(['run_command', 'run_tests']);

export interface ApprovalRequest {
  tool: string;
  permissions: string[];
  /** Human-readable summary of what the tool intends to do. */
  summary: string;
}

export interface ApprovalDecision {
  approved: boolean;
  /** Remember the decision for the rest of the session for this tool. */
  sessionOnly?: boolean;
}

export interface WorkspacePolicyOptions {
  root: string;
  mode: PermissionMode;
  /**
   * Live posture provider (Phase T): when given, it is consulted on every
   * tool call so mode switches take effect immediately. When absent, the
   * static `mode` above is used.
   */
  getMode?: () => PermissionMode;
  /** Prompt shown to the user when a tool needs approval (ask flows). */
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  /**
   * Project-level per-tool allow/deny rules (from .agentforge/permissions.json).
   * Deny blocks a tool in every mode; allow skips the approval prompt but
   * never bypasses workspace path checks.
   */
  rules?: readonly PermissionRule[];
}

/** run_command invocation shape for structured rule matching. */
function commandContextOf(tool: string, input: unknown): CommandContext | undefined {
  if (tool !== 'run_command') return undefined;
  const value = input as { command?: string; args?: string[] };
  if (typeof value?.command !== 'string') return undefined;
  return { command: value.command, args: value.args };
}

/**
 * Wrap a tool so it enforces the active permission mode:
 * workspace scoping for path-bearing inputs, approval prompts for
 * mutations/commands, and hard denial outside policy.
 */
export function applyWorkspacePolicy(tool: PolicyTool, options: WorkspacePolicyOptions): PolicyTool {
  const root = resolve(options.root);
  // The posture is resolved per call (Phase T): mode switches (/plan, /build,
  // /permissions, session modes) take effect immediately for live tools.
  const currentMode = (): PermissionMode => (options.getMode ? options.getMode() : options.mode);
  let remembered: ApprovalDecision | undefined;

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    permissions: tool.permissions,
    timeoutMs: tool.timeoutMs,
    retries: tool.retries,
    async execute(input, context) {
      // Structured rules (Phase G) take precedence over mode defaults, before
      // anything runs: globs, dotted hierarchies, run_command prefixes, and
      // external-directory grants all evaluate here.
      const commandContext = commandContextOf(tool.name, input);
      const ruleVerdict = evaluateInvocationRules(
        options.rules ?? [],
        commandContext ? { tool: tool.name, command: commandContext } : { tool: tool.name },
      );
      if (ruleVerdict === 'deny') {
        throw new Error(`Tool ${tool.name} is blocked by a project permission rule (.agentforge/permissions.json).`);
      }

      // Workspace boundary checks for well-known path-bearing inputs. A path
      // rule grant (external_directory allow) extends the readable boundary.
      const candidate = input as { path?: string };
      if (typeof candidate?.path === 'string') {
        const external = externalDirectories(options.rules ?? [], root);
        if (!isPathAllowed(root, candidate.path, external)) {
          throw new Error(`Path escapes the workspace root (${root}); refusing ${tool.name}.`);
        }
      }

      const mode = currentMode();
      const autoAllowed = MODE_ALLOWED_PERMISSIONS[mode];
      const missing = (tool.permissions ?? []).filter((permission) => !autoAllowed.has(permission));

      if (ruleVerdict === 'allow') {
        // Explicit allow: no approval prompt, but path checks above still apply.
        return tool.execute(input, context);
      }

      if (!missing.length || mode === 'read-only') {
        if (mode === 'read-only' && missing.length) {
          throw new Error(`Tool ${tool.name} is not permitted in read-only mode (requires: ${missing.join(', ')}).`);
        }
        return tool.execute(input, context);
      }

      if (!remembered) {
        if (!options.requestApproval) {
          throw new Error(`Tool ${tool.name} requires approval but no approval prompt is available (requires: ${missing.join(', ')}).`);
        }
        const summary = summarize(tool.name, input);
        remembered = await options.requestApproval({ tool: tool.name, permissions: missing, summary });
      }
      if (!remembered.approved) throw new Error(`User denied ${tool.name} (requires: ${missing.join(', ')}).`);
      return tool.execute(input, context);
    },
  };
}

function summarize(tool: string, input: unknown): string {
  if (tool === 'run_command') {
    const value = input as { command?: string; args?: string[] };
    return `Execute command: ${value.command ?? '?'} ${(value.args ?? []).join(' ')}`.trim();
  }
  if (tool === 'run_tests') {
    const value = input as { pattern?: string };
    return `Run project tests${value.pattern ? ` matching '${value.pattern}'` : ''}`;
  }
  if (tool === 'apply_patch') {
    return 'Apply a file patch inside the workspace (diff will be shown).';
  }
  return `Use ${tool}`;
}
