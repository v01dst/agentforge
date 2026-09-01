import { Agent, type AgentInterceptors } from '@agentforge-oss/core';
import { createModel } from '@agentforge-oss/models';
import { createMemoryTool } from '../memory/tool.js';
import { createSkillManageTool } from '../skills/tools.js';

export interface ReflectionConfig {
  /** Off by default (Phase C doctrine): the fork costs tokens every turn. */
  enabled: boolean;
  /** Aux model override; defaults to the session provider. */
  provider?: string;
  model?: string;
  /** Injected backing model (tests). */
  modelInstance?: unknown;
  /** Max characters of conversation digest replayed to the reviewer. */
  digestChars?: number;
}

export interface ReflectionOptions extends ReflectionConfig {
  root: string;
  /** Memory writes from the reviewer land in the global store. */
  memoryGlobal?: boolean;
}

const DEFAULT_DIGEST_CHARS = 6_000;

/** Build the compact digest replayed to the reviewer. */
export function buildDigest(inputs: string[], output: string, limit = DEFAULT_DIGEST_CHARS): string {
  const parts: string[] = [];
  for (const input of inputs.slice(-8)) parts.push(`User: ${input}`);
  parts.push(`Assistant (latest): ${output}`);
  let digest = parts.join('\n');
  if (digest.length > limit) digest = `…${digest.slice(digest.length - limit)}`;
  return digest;
}

const REVIEW_INSTRUCTIONS = [
  'You are the AgentForge reflection reviewer. A conversation digest follows.',
  'Decide whether any durable lesson, preference, environment fact, or reusable workflow should persist.',
  'If yes, save it with the memory tool (one compact entry per fact) or propose a skill with skill_manage.',
  'Never save trivia, one-off details, or anything already obvious. If nothing is worth saving, do nothing.',
].join(' ');

export interface ReflectionRuntime {
  /** Observer hook for the interceptor seam: records input, reviews after each turn. */
  interceptors: Pick<AgentInterceptors, 'preStep' | 'turnStopping'>;
  /** Manual trigger (`/refine`): run the review now against the latest turn. */
  reviewNow: (output: string) => Promise<string>;
}

/**
 * Phase C: the self-improvement loop. After each turn (fire-and-forget), a
 * reviewer agent replays a conversation digest and may write memory entries
 * or stage skill improvements — the same gated tools the main agent uses.
 * Disabled unless explicitly configured; review failures never break turns.
 */
export function createReflectionRuntime(options: ReflectionOptions): ReflectionRuntime {
  const inputs: string[] = [];
  let lastOutput = '';
  let running = false;

  const createReviewer = (): Agent => {
    const model = options.modelInstance
      ?? (options.provider ? createModel({ provider: options.provider as never, model: options.model }) : undefined);
    const skillManage = createSkillManageTool({ root: options.root, writeApproval: false });
    const memory = createMemoryTool({ root: options.root, global: options.memoryGlobal });
    return new Agent({
      name: 'agentforge-reflection',
      model: model as never,
      tools: [memory as never, skillManage as never],
      instructions: REVIEW_INSTRUCTIONS,
      maxIterations: 6,
    });
  };

  const review = async (output: string): Promise<string> => {
    if (running) return 'reflection: previous review still running';
    running = true;
    try {
      const reviewer = createReviewer();
      const result = await reviewer.run(buildDigest(inputs, output, options.digestChars), {});
      return `reflection: ${result.output.slice(0, 200) || 'nothing worth persisting'}`;
    } catch (error) {
      return `reflection failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      running = false;
    }
  };

  return {
    interceptors: {
      preStep: [
        async ({ input }) => {
          inputs.push(input);
          return undefined; // observe-only; never rewrites
        },
      ],
      turnStopping: [
        (result) => {
          lastOutput = result.output;
          // Fire-and-forget: the review must never delay or rewrite the turn.
          void review(result.output).catch(() => {});
          return Promise.resolve(undefined);
        },
      ],
    },
    reviewNow: review,
  };
}
