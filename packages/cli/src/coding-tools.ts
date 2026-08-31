import {
  createListFilesTool,
  createReadFileTool,
  createSearchTextTool,
} from '@agentforge-oss/tools';
import {
  createApplyPatchTool,
  createGitDiffTool,
} from '@agentforge-oss/tools';
import {
  createRunCommandTool,
  createRunTestsTool,
} from '@agentforge-oss/tools';
import {
  applyWorkspacePolicy,
  currentPermissionMode,
  type ApprovalRequest,
  type ApprovalDecision,
} from './permissions.js';
import type { PermissionRule } from './permissions-store.js';
import { createMemoryTool } from './memory/tool.js';

/** Structural tool shape accepted by the workspace policy layer. */
export type PolicyTool = Parameters<typeof applyWorkspacePolicy>[0];

export interface CodingToolsOptions {
  /** Workspace root; all tools are scoped to this directory. Defaults to cwd. */
  root?: string;
  /**
   * Commands the run_command tool may execute. Empty (default) disables it
   * until the project explicitly allowlists programs.
   */
  allowedCommands?: string[];
  /** Shell command used by run_tests when auto-discovery is not wanted. */
  testCommand?: { command: string; args: string[] };
  /** Approval prompt callback for 'ask' mode. */
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  /** Per-tool allow/deny rules; deny blocks, allow skips prompting. */
  permissionRules?: readonly PermissionRule[];
  /** Memory store scope: project (default) or global (~/.agentforge). */
  memoryGlobal?: boolean;
  /** When true, memory writes are rejected (read-only contexts). */
  memoryReadOnly?: boolean;
}

/**
 * Build the repository-aware coding toolset (Milestone C):
 * list_files, read_file, search_text, apply_patch, inspect_git_diff,
 * run_command, run_tests — each wrapped in the active permission mode's
 * workspace policy.
 */
export function createCodingTools(options: CodingToolsOptions = {}): PolicyTool[] {
  const root = options.root ?? process.cwd();
  const allowedCommands = options.allowedCommands ?? [];
  const policy = { root, mode: currentPermissionMode(), requestApproval: options.requestApproval, rules: options.permissionRules };

  const tools: PolicyTool[] = [
    createListFilesTool({ root }) as unknown as PolicyTool,
    createReadFileTool({ root }) as unknown as PolicyTool,
    createSearchTextTool({ root }) as unknown as PolicyTool,
    createApplyPatchTool({ root, allowWrite: true }) as unknown as PolicyTool,
    createGitDiffTool({ root }) as unknown as PolicyTool,
  ];
  if (allowedCommands.length) tools.push(createRunCommandTool({ root, allowedCommands }) as unknown as PolicyTool);
  tools.push(createRunTestsTool({ root, testCommand: options.testCommand }) as unknown as PolicyTool);
  const mode = currentPermissionMode();
  const memory = createMemoryTool({
    root,
    global: options.memoryGlobal,
    readOnly: options.memoryReadOnly || mode === 'read-only',
  }) as unknown as PolicyTool;
  tools.push(memory);
  return tools.map((tool) => applyWorkspacePolicy(tool, policy));
}
