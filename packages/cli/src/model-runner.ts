import type { TurnRunner } from './ui/turn.js';
import { createModel } from '@agentforge-oss/models';

/** Structural view of a core BackingModel (CLI stays decoupled from @agentforge-oss/core). */
interface BackingModel {
  readonly provider: string;
  readonly model?: string;
  generate(request: never): Promise<unknown>;
  stream?(request: { messages: Array<{ role: string; content: string }>; model?: string; signal?: AbortSignal }): AsyncIterable<{
    delta: string;
    usage?: { totalTokens: number };
  }>;
}

export interface ResolvedRunner {
  provider: string;
  model: string;
  runner: TurnRunner;
}

const PROVIDER_PRIORITY: ReadonlyArray<{ id: string; env: string; model: string }> = [
  { id: 'anthropic', env: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-4-5' },
  { id: 'openai', env: 'OPENAI_API_KEY', model: 'gpt-4o-mini' },
  { id: 'google', env: 'GEMINI_API_KEY', model: 'gemini-2.0-flash' },
  { id: 'google', env: 'GOOGLE_API_KEY', model: 'gemini-2.0-flash' },
];

function guessModel(provider: string): string {
  switch (provider) {
    case 'openai': return 'gpt-4o-mini';
    case 'anthropic': return 'claude-sonnet-4-5';
    case 'google': case 'gemini': return 'gemini-2.0-flash';
    default: return 'gpt-4o-mini';
  }
}

/**
 * Pick the active provider without any project configuration:
 * explicit AGENTFORGE_PROVIDER wins, otherwise the first provider with a
 * credential in the environment; otherwise the offline mock.
 */
export function detectDefaultProvider(env: NodeJS.ProcessEnv = process.env): { provider: string; model: string } {
  const explicitProvider = env.AGENTFORGE_PROVIDER;
  const explicitModel = env.AGENTFORGE_MODEL;
  if (explicitProvider === 'mock') return { provider: 'mock', model: explicitModel ?? 'mock' };
  if (explicitProvider) {
    return { provider: explicitProvider, model: explicitModel ?? guessModel(explicitProvider) };
  }
  for (const candidate of PROVIDER_PRIORITY) {
    if (env[candidate.env]) return { provider: candidate.id, model: explicitModel ?? candidate.model };
  }
  return { provider: 'mock', model: explicitModel ?? 'mock' };
}

/** Build a streaming TurnRunner over a BackingModel (token-by-token). */
function streamViaModel(backing: BackingModel, model: string): TurnRunner {
  return async function* runModelTurn(input, signal) {
    let text = '';
    try {
      for await (const chunk of backing.stream!({ messages: [{ role: 'user', content: input }], model, signal })) {
        if (signal.aborted) break;
        if (chunk.delta) {
          text += chunk.delta;
          yield { text: chunk.delta };
        }
        if (chunk.usage?.totalTokens) {
          yield { usage: { totalTokens: chunk.usage.totalTokens } };
        }
      }
      void text;
    } catch (error) {
      // Surface provider errors as readable chat output instead of crashing.
      const message = error instanceof Error ? error.message : String(error);
      yield { text: `⚠ provider error: ${message}` };
    }
  };
}

/**
 * Resolve a REAL streaming TurnRunner with zero project configuration:
 * provider/model come from environment detection or AGENTFORGE_* overrides,
 * and the heavy lifting is delegated to @agentforge-oss/models adapters.
 */
export async function resolveModelRunner(overrides?: { provider?: string; model?: string }): Promise<ResolvedRunner> {
  const detected = detectDefaultProvider();
  const provider = overrides?.provider ?? detected.provider;
  const model = overrides?.model ?? detected.model;

  let backing: BackingModel | undefined;
  try {
    backing = createModel({ provider: provider as never, model });
  } catch {
    backing = undefined;
  }

  if (!backing || typeof backing.stream !== 'function') {
    const echo: TurnRunner = async function* (input) {
      yield { text: `[${provider} has no streaming support] you said: ${input}` };
    };
    return { provider, model, runner: echo };
  }

  return { provider, model, runner: streamViaModel(backing, model) };
}
