import { z } from 'zod';
import { Agent, type ToolLike } from '@agentforge-oss/core';
import { createModel, DEFAULT_MODEL_IDS } from '@agentforge-oss/models';
import type { AgentInfo, AgentPermission } from './agents.js';
import { getAgentSync } from './agents.js';
import { applyWorkspacePolicy, type ApprovalRequest, type ApprovalDecision } from '../permissions.js';
import type { PermissionRule } from '../permissions-store.js';
import { createCodingTools, type PolicyTool } from '../coding-tools.js';

export interface TaskToolOptions {
  /** Workspace root for subagent tools. */
  root: string;
  /** Backing model instance (tests / shared provider); created from provider/model when absent. */
  modelInstance?: unknown;
  provider?: string;
  model?: string;
  /** Commands allowlist forwarded to subagent run_command tools. */
  allowedCommands?: string[];
  testCommand?: { command: string; args: string[] };
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  permissionRules?: readonly PermissionRule[];
  /** Cap on the child agent's reported output. */
  outputCap?: number;
}

/** Tool names a subagent may receive per permission posture (one policy layer). */
export function subagentToolNames(permission: AgentPermission | undefined): readonly string[] {
  switch (permission) {
    case 'trusted':
      return ['list_files', 'read_file', 'search_text', 'inspect_git_diff', 'apply_patch', 'run_tests', 'run_command', 'skill_view', 'skill_manage', 'memory'];
    case 'workspace-write':
      return ['list_files', 'read_file', 'search_text', 'inspect_git_diff', 'apply_patch', 'run_tests', 'skill_view', 'memory'];
    case 'read-only':
    default:
      return ['list_files', 'read_file', 'search_text', 'inspect_git_diff', 'skill_view'];
  }
}

function childToolset(agent: AgentInfo, options: TaskToolOptions): ToolLike[] {
  const allowed = new Set(subagentToolNames(agent.permission));
  // Subagents never author skills or edit memory — those are primary-agent duties.
  allowed.delete('skill_manage');
  const mode: 'read-only' | 'workspace-write' | 'trusted' = agent.permission ?? 'read-only';
  const coding = createCodingTools({
    root: options.root,
    allowedCommands: options.allowedCommands,
    testCommand: options.testCommand,
    requestApproval: options.requestApproval,
    permissionRules: options.permissionRules,
  });
  const selected = coding.filter((tool: PolicyTool) => allowed.has(tool.name));
  const policy = { root: options.root, mode, getMode: () => mode, requestApproval: options.requestApproval, rules: options.permissionRules };
  return selected.map((tool) => applyWorkspacePolicy(tool, policy)) as unknown as ToolLike[];
}

function resolveBackingModel(options: TaskToolOptions, agent: AgentInfo): unknown {
  if (options.modelInstance) return options.modelInstance;
  try {
    return createModel({ provider: (options.provider ?? 'anthropic') as never, model: agent.model ?? options.model ?? DEFAULT_MODEL_IDS.anthropic });
  } catch {
    return undefined;
  }
}

/**
 * The `task` tool (Phase F): spawns a child agent run with the named
 * subagent's prompt and a posture-filtered toolset, and returns the child's
 * final text. Runs synchronously inside the tool call; the child's tool calls
 * go through the same policy layer as the parent's.
 */
export function createTaskTool(options: TaskToolOptions, cwd = process.cwd()): ToolLike {
  const outputCap = options.outputCap ?? 4000;
  return {
    name: 'task',
    description: [
      'Delegate a task to a named subagent and wait for its final report.',
      'Use this for focused multi-step work that does not need the main conversation:',
      'codebase exploration (explore), or general multi-step tasks (general).',
      'The subagent sees only the prompt you give it — include all needed context.',
    ].join(' '),
    inputSchema: z.object({
      agent: z.string().min(1).optional().describe('Subagent name (default: general).'),
      prompt: z.string().min(1).describe('Complete, self-contained task for the subagent.'),
    }),
    async execute(input) {
      const parsed = input as { agent?: string; prompt: string };
      const name = parsed.agent ?? 'general';
      const agent = getAgentSync(name, cwd);
      if (!agent) {
        const known = ['explore', 'general'];
        return { ok: false, error: `Unknown subagent: ${name}. Available: ${known.join(', ')}.` };
      }
      if (agent.mode === 'primary') {
        return { ok: false, error: `${name} is a primary agent definition — it cannot be spawned as a subagent.` };
      }
      const backing = resolveBackingModel(options, agent);
      if (!backing || typeof (backing as { generate?: unknown }).generate !== 'function') {
        return { ok: false, error: 'No model provider available for the subagent run.' };
      }
      const child = new Agent({
        name: `subagent:${agent.name}`,
        model: backing as never,
        instructions: agent.body,
        tools: childToolset(agent, options),
        maxIterations: agent.steps ?? 8,
      });
      try {
        const result = await child.run(parsed.prompt);
        const text = result.output.length > outputCap
          ? `${result.output.slice(0, outputCap)}…[truncated]`
          : result.output;
        return { ok: true, agent: agent.name, output: text };
      } catch (error) {
        return { ok: false, error: `Subagent ${agent.name} failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  };
}
