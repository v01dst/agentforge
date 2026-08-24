import { relative, resolve, isAbsolute } from 'node:path';

/** Structural view of a core ToolLike; the CLI intentionally does not depend on @agentforge/core. */
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
  /** Prompt shown to the user when a tool needs approval (ask flows). */
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
}

function withinRoot(root: string, candidate?: string): boolean {
  if (!candidate) return true;
  const full = isAbsolute(candidate) ? candidate : resolve(root, candidate);
  const rel = relative(root, full);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Wrap a tool so it enforces the active permission mode:
 * workspace scoping for path-bearing inputs, approval prompts for
 * mutations/commands, and hard denial outside policy.
 */
export function applyWorkspacePolicy(tool: PolicyTool, options: WorkspacePolicyOptions): PolicyTool {
  const root = resolve(options.root);
  const autoAllowed = MODE_ALLOWED_PERMISSIONS[options.mode];
  const missing = (tool.permissions ?? []).filter((permission) => !autoAllowed.has(permission));
  const needsApproval = missing.length > 0 && options.mode !== 'read-only';
  let remembered: ApprovalDecision | undefined;

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    permissions: tool.permissions,
    timeoutMs: tool.timeoutMs,
    retries: tool.retries,
    async execute(input, context) {
      // Workspace boundary checks for well-known path-bearing inputs.
      const candidate = input as { path?: string };
      if (typeof candidate?.path === 'string' && !withinRoot(root, candidate.path)) {
        throw new Error(`Path escapes the workspace root (${root}); refusing ${tool.name}.`);
      }

      if (!missing.length || options.mode === 'read-only') {
        if (options.mode === 'read-only' && missing.length) {
          throw new Error(`Tool ${tool.name} is not permitted in read-only mode (requires: ${missing.join(', ')}).`);
        }
        return tool.execute(input, context);
      }

      if (!needsApproval) return tool.execute(input, context);

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
