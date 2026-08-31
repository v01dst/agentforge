import { resolve } from 'node:path';
import { Agent, EventBus, type AgentEvent, type ToolLike } from '@agentforge-oss/core';
import { createModel } from '@agentforge-oss/models';
import type { TurnRunner, TurnDelta } from './ui/turn.js';
import { createCodingTools } from './coding-tools.js';
import type { ApprovalRequest, ApprovalDecision } from './permissions.js';
import { requestToolApproval } from './approvals.js';
import { detectDefaultProvider } from './model-runner.js';
import { readPermissionRulesSync } from './permissions-store.js';
import { loadMemorySync, loadPersonaSourcesSync, renderPersonaBlock } from './memory/store.js';
import { listSkillsSync, renderSkillIndex } from './skills/skills.js';
import { listAgentsSync, renderAgentIndex } from './agents/agents.js';
import type { AgentForgePlugin } from './plugins/plugins.js';
import { createReflectionRuntime, type ReflectionConfig } from './reflection/review.js';
import { createCompressionInterceptor } from './context/compression.js';
import { createDoomLoopGuard } from './guards/doom-loop.js';

export interface CodingSessionOptions {
  /** Workspace root for repository tools (defaults to cwd). */
  root?: string;
  provider?: string;
  model?: string;
  /** Inject a backing model directly (tests); overrides provider/model. */
  modelInstance?: unknown;
  instructions?: string;
  /** Extra tools merged after the coding set (plugins/MCP already resolved). */
  extraTools?: readonly ToolLike[];
  /** Queue bridge for tests; defaults to the UI approval bus. */
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  /** Plugin hook contributions merged into the core interceptor seam. */
  pluginHooks?: AgentForgePlugin['hooks'];
  /** Phase C reflection config; enabled only when explicitly configured. */
  reflection?: ReflectionConfig;
  /** Phase D live context compression tuning; defaults keep 96k chars / 20 recent messages. */
  compression?: { maxChars?: number; keepRecent?: number; foldTextCap?: number };
}

interface QueuedEvent {
  data?: { tool?: string; durationMs?: number };
}

/**
 * Build the default interactive runner: a real core Agent over the detected
 * provider with the seven policy-wrapped coding tools attached. Core falls
 * back to non-streaming while tools are attached, so token deltas are not
 * available here — instead we surface LIVE tool events through the same
 * TurnDelta channel, then the final text/usage/runId.
 */
export function buildAgentRunner(options: CodingSessionOptions = {}): TurnRunner {
  const root = resolve(options.root ?? process.cwd());
  const detectedBase = detectDefaultProvider();
  const detected = {
    provider: options.provider ?? detectedBase.provider,
    model: options.model ?? detectedBase.model,
  };
  let backing: unknown;
  if (options.modelInstance) backing = options.modelInstance;
  else {
    try {
      backing = createModel({ provider: detected.provider as never, model: detected.model });
    } catch {
      backing = undefined;
    }
  }
  if (!backing || typeof (backing as { generate?: unknown }).generate !== 'function') {
    return async function* (input) {
      yield { text: `[${detected.provider} unavailable] you said: ${input}` };
    };
  }

  const events = new EventBus();
  const approver = options.requestApproval ?? ((request: ApprovalRequest) => requestToolApproval(request));
  const permissionRules = readPermissionRulesSync(root);
  const codingTools: ToolLike[] = createCodingTools({
    root,
    requestApproval: approver,
    permissionRules,
    subagentModel: options.modelInstance,
    subagentProvider: detected.provider,
    subagentModelName: detected.model,
  }) as unknown as ToolLike[];

  // Frozen snapshot: persona + memory are captured once at runner build
  // (session start) and never mutate mid-session — tool results show live state.
  const instructionBlocks: string[] = [
    options.instructions ?? [
      'You are AgentForge, a terminal coding agent.',
      'Use the provided repository tools to inspect files, apply patches, and run commands when appropriate.',
      'Be concise and factual.',
    ].join(' '),
  ];
  const persona = renderPersonaBlock(loadPersonaSourcesSync(root));
  if (persona) instructionBlocks.push(persona);
  // Progressive disclosure (Phase B): the index is always present; bodies
  // load on demand through skill_view, or directly when /skills selects them.
  const skillIndex = renderSkillIndex(listSkillsSync(root));
  if (skillIndex) instructionBlocks.push(skillIndex);
  // Phase F: subagent index so the model knows which agents it can delegate to.
  const agentIndex = renderAgentIndex(listAgentsSync(root));
  if (agentIndex) instructionBlocks.push(agentIndex);
  const memorySnapshot = loadMemorySync('memory', root);
  if (memorySnapshot.entries.length) {
    instructionBlocks.push(`Persistent memory for future sessions — consolidate before adding when above 80% capacity.`);
    instructionBlocks.push(memorySnapshot.entries.join('§'));
  }

  // Phase C: reflection runtime (off by default) contributes observe-only
  // interceptors; its reviewer writes go through the same gated tools.
  const reflection = options.reflection?.enabled
    ? createReflectionRuntime({ ...options.reflection, root })
    : undefined;

  const agent = new Agent({
    name: 'agentforge',
    model: backing as never,
    tools: [...codingTools, ...(options.extraTools ?? [])],
    instructions: instructionBlocks.filter(Boolean).join('\n\n'),
    events,
    interceptors: {
      preStep: [
        ...(reflection?.interceptors.preStep ?? []),
        ...(options.pluginHooks?.preStep as never[] ?? []),
      ],
      preRequest: [
        createCompressionInterceptor(options.compression),
        ...(options.pluginHooks?.preRequest as never[] ?? []),
      ],
      preTool: [
        createDoomLoopGuard(),
        ...(options.pluginHooks?.preTool as never[] ?? []),
      ],
      postTool: options.pluginHooks?.postTool as never,
      turnStopping: [
        ...(reflection?.interceptors.turnStopping ?? []),
        ...(options.pluginHooks?.turnStopping as never[] ?? []),
      ],
    },
  });

  return async function* runAgentTurn(input, signal, context): AsyncGenerator<TurnDelta> {
    const queue: Array<{ delta: TurnDelta } | { result: unknown } | { error: unknown }> = [];
    const gate: { wake: (() => void) | null } = { wake: null };
    const push = (entry: (typeof queue)[number]) => { queue.push(entry); gate.wake?.(); gate.wake = null; };
    const waitForWork = (): Promise<void> => new Promise((resolveWait) => {
      if (queue.length > 0 || finished) resolveWait();
      else gate.wake = resolveWait;
    });
    let finished = false;

    const removeSink = events.addSink({
      emit(event: AgentEvent) {
        if (event.type === 'tool.started') {
          push({ delta: { tool: { name: String((event.data as QueuedEvent['data'])?.tool ?? 'tool'), state: 'running' } } });
        } else if (event.type === 'tool.completed' || event.type === 'tool.failed') {
          const data = event.data as QueuedEvent['data'];
          push({ delta: { tool: { name: String(data?.tool ?? 'tool'), state: 'done', ms: typeof data?.durationMs === 'number' ? data.durationMs : undefined } } });
        }
        return Promise.resolve();
      },
    });

    try {
      const runPromise = agent.run(withSkills(input, context?.skills), { signal })
        .then((result: unknown) => push({ result }))
        .catch((error: unknown) => push({ error }));

      let result: unknown;
      let failure: unknown;
      while (true) {
        await waitForWork();
        while (queue.length > 0) {
          const entry = queue.shift() as (typeof queue)[number];
          if ('delta' in entry) yield entry.delta;
          else if ('result' in entry) result = entry.result;
          else failure = entry.error;
        }
        if (failure !== undefined || result !== undefined || finished) break;
      }
      await runPromise;
      removeSink();

      if (failure !== undefined) throw failure;

      const record = result as { output?: unknown; runId?: string; usage?: { totalTokens?: number }; durationMs?: number } | undefined;
      if (record && typeof record === 'object') {
        if (typeof record.runId === 'string') yield { runId: record.runId };
        if (record.usage?.totalTokens) yield { usage: { totalTokens: record.usage.totalTokens } };
        yield { text: typeof record.output === 'string' ? record.output : JSON.stringify(record.output, null, 2) };
      }
    } finally {
      finished = true;
      gate.wake?.();
      removeSink();
    }
  };
}


function withSkills(input: string, skills?: readonly string[]): string {
  if (!skills?.length) return input;
  const preamble = skills.map((body) => `[skill active]\n${body}`).join('\n\n');
  return `${preamble}\n\n${input}`;
}
