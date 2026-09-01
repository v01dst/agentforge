import type { ModelProvider } from '@agentforge-oss/core';
import { createConfiguredModel, isProviderReady, type ProviderDefinition } from '@agentforge-oss/models';

export interface ModelSelectionRequest {
  /** Provider protocol: openai | anthropic | google | gemini | openai-compatible (mock removed in 0.8) */
  provider?: string;
  model?: string;
  /** Endpoint override; required for openai-compatible. */
  baseUrl?: string;
  /** Name of the environment variable that holds the API key on the server. Raw keys are never accepted. */
  apiKeyEnv?: string;
}

export const SUPPORTED_PROTOCOLS: ReadonlyArray<string> = ['openai', 'anthropic', 'google', 'gemini', 'openai-compatible'];

const DEFAULT_KEY_ENV_HINTS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY (or GEMINI_API_KEY)',
};

/**
 * Resolve the requested playground model against server-side environment
 * credentials. Returns either a ready ModelProvider or a user-facing error
 * that names the missing configuration. Raw API keys are never accepted
 * through the request body — only environment variable names.
 */
export function resolveRequestedModel(body: ModelSelectionRequest, env: NodeJS.ProcessEnv = process.env): { model: ModelProvider } | { error: string } {
  const provider = body.provider ?? '';
  if (!provider) {
    return { error: `No provider selected. Available providers: ${SUPPORTED_PROTOCOLS.join(', ')} (configure credentials in the server environment).` };
  }
  if (!SUPPORTED_PROTOCOLS.includes(provider)) {
    return { error: `Unsupported provider '${provider}'. Available providers: ${SUPPORTED_PROTOCOLS.join(', ')}.` };
  }
  const definition: ProviderDefinition = {
    name: provider,
    protocol: provider as ProviderDefinition['protocol'],
    model: body.model?.trim() || undefined,
    baseUrl: body.baseUrl?.trim() || undefined,
    apiKeyEnv: body.apiKeyEnv?.trim() || undefined,
  };
  if (!isProviderReady(definition, env)) {
    if (definition.protocol === 'openai-compatible' && !definition.baseUrl) {
      return { error: 'The openai-compatible provider requires a base URL (for example https://openrouter.ai/api/v1).' };
    }
    const hint = definition.apiKeyEnv ?? DEFAULT_KEY_ENV_HINTS[definition.protocol] ?? 'a credential environment variable';
    return { error: `${provider} is not configured: set ${hint} in the playground server environment. The playground never accepts raw API keys over HTTP.` };
  }
  try {
    return { model: createConfiguredModel(definition, env) };
  } catch (caught) {
    return { error: caught instanceof Error ? caught.message : String(caught) };
  }
}
