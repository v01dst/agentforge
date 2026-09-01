import type { TurnRunner } from './ui/turn.js';
import { createModel } from '@agentforge-oss/models';
import { resolveCredential } from './credentials.js';
import type { ProviderPreset } from './providers-catalog.js';

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

/**
 * Built-in first-party providers considered during automatic detection
 * (0.8: mock removed — detection requires a credential from the environment
 * or the ~/.agentforge/credentials.json store).
 */
const PROVIDER_PRIORITY: ReadonlyArray<{ id: string; env: string; model: string }> = [
  { id: 'anthropic', env: 'ANTHROPIC_API_KEY', model: 'claude-opus-5' },
  { id: 'openai', env: 'OPENAI_API_KEY', model: 'gpt-5.6-sol' },
  { id: 'google', env: 'GEMINI_API_KEY', model: 'gemini-2.0-flash' },
  { id: 'google', env: 'GOOGLE_API_KEY', model: 'gemini-2.0-flash' },
];

function guessModel(provider: string): string {
  switch (provider) {
    case 'openai': return 'gpt-5.6-sol';
    case 'anthropic': return 'claude-opus-5';
    case 'google': case 'gemini': return 'gemini-2.0-flash';
    default: return 'gpt-5.6-sol';
  }
}

/**
 * Pick the active provider: explicit AGENTFORGE_PROVIDER wins, otherwise the
 * first first-party provider with a credential (env → credentials store).
 * `undefined` means nothing is configured — callers show onboarding instead
 * of silently degrading to a fake model.
 */
export function detectDefaultProvider(env: NodeJS.ProcessEnv = process.env): { provider: string; model: string } | undefined {
  const explicitProvider = env.AGENTFORGE_PROVIDER;
  const explicitModel = env.AGENTFORGE_MODEL;
  if (explicitProvider) {
    return { provider: explicitProvider, model: explicitModel ?? guessModel(explicitProvider) };
  }
  for (const candidate of PROVIDER_PRIORITY) {
    if (env[candidate.env]) return { provider: candidate.id, model: explicitModel ?? candidate.model };
  }
  return undefined;
}

/**
 * Credential-aware detection: same ladder as `detectDefaultProvider` but also
 * consults the credentials store synchronously-ish (best effort, async).
 */
export async function detectDefaultProviderWithCredentials(env: NodeJS.ProcessEnv = process.env, home?: string): Promise<{ provider: string; model: string } | undefined> {
  const explicit = detectDefaultProvider(env);
  if (explicit) return explicit;
  for (const candidate of PROVIDER_PRIORITY) {
    if (await resolveCredential(candidate.env, env, home)) return { provider: candidate.id, model: candidate.model };
  }
  return undefined;
}

/** Default model id for a preset-backed provider (catalog-aware guess). */
export function defaultModelForPreset(preset: ProviderPreset): string {
  return preset.model;
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
 * Returns undefined when no provider is configured — the TUI shows ez-start.
 */
export async function resolveModelRunner(overrides?: { provider?: string; model?: string }): Promise<ResolvedRunner | undefined> {
  await injectStoredCredentials();
  const detected = await detectDefaultProviderWithCredentials();
  const provider = overrides?.provider ?? detected?.provider;
  const model = overrides?.model ?? detected?.model ?? guessModel(provider!);
  if (!provider) return undefined;

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

/** Fill env gaps from the credentials store (env vars always win). */
async function injectStoredCredentials(): Promise<void> {
  const { injectCredentialsIntoEnv } = await import('./credentials.js');
  await injectCredentialsIntoEnv();
}
