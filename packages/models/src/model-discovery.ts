import type { ModelProvider } from '@agentforge-oss/core';
import { ModelHttpError } from './providers.js';

/**
 * Live model discovery (0.8): fetch a provider's model list straight from
 * its endpoint instead of shipping hardcoded lists. Protocol-aware:
 *
 * - OpenAI + OpenAI-compatible (OpenRouter, DeepSeek, Groq, xAI, Mistral,
 *   Together, Fireworks, Cerebras, Moonshot, Z.AI, Perplexity, Ollama,
 *   LM Studio): `GET {baseUrl}/models` → `{ data: [{ id, ... }] }`.
 * - Anthropic: `GET {baseUrl}/v1/models` with `x-api-key` + `anthropic-version`.
 * - Google: `GET {baseUrl}/models?key=…` → `{ models: [{ name, ... }] }`
 *   (names arrive as `models/gemini-…` — the prefix is stripped).
 *
 * The returned ids are strings suitable for `createModel({ model })` and
 * the TUI model picker. Errors surface honestly — callers fall back to a
 * preset default when a provider does not implement listing.
 */

export interface RemoteModel {
  id: string;
  /** Optional display metadata when the endpoint provides it. */
  contextWindow?: number;
  ownedBy?: string;
}

export interface ListModelsOptions {
  protocol: 'openai' | 'anthropic' | 'google' | 'openai-compatible';
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

function authHeaders(options: ListModelsOptions): Record<string, string> {
  switch (options.protocol) {
    case 'anthropic':
      return options.apiKey
        ? { 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01' }
        : { 'anthropic-version': '2023-06-01' };
    case 'openai':
    case 'openai-compatible':
      return options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {};
    case 'google':
      return {};
  }
}

function modelsUrl(options: ListModelsOptions): string {
  const base = options.baseUrl.replace(/\/+$/, '');
  if (options.protocol === 'anthropic') {
    // Anthropic lists at /v1/models; presets already include /v1.
    return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
  }
  return `${base}/models`;
}

interface WireModel {
  id?: unknown;
  name?: unknown;
  model?: unknown;
  display_name?: unknown;
  context_window?: unknown;
  input_token_limit?: unknown;
  owned_by?: unknown;
  ownedBy?: unknown;
}

function normalizeModel(wire: WireModel, protocol: ListModelsOptions['protocol']): RemoteModel | undefined {
  let id: string | undefined;
  if (protocol === 'google') {
    const name = typeof wire.name === 'string' ? wire.name : undefined;
    if (!name) return undefined;
    id = name.startsWith('models/') ? name.slice('models/'.length) : name;
  } else {
    id = typeof wire.id === 'string' ? wire.id
      : typeof wire.model === 'string' ? wire.model
      : undefined;
  }
  if (!id) return undefined;
  const contextWindow = typeof wire.context_window === 'number' ? wire.context_window
    : typeof wire.input_token_limit === 'number' ? wire.input_token_limit
    : undefined;
  const ownedBy = typeof wire.owned_by === 'string' ? wire.owned_by
    : typeof wire.ownedBy === 'string' ? wire.ownedBy
    : undefined;
  return { id, ...(contextWindow !== undefined ? { contextWindow } : {}), ...(ownedBy !== undefined ? { ownedBy } : {}) };
}

/**
 * Fetch the model list from a provider endpoint. Throws `ModelHttpError`
 * on HTTP failures (callers can fall back to preset defaults) and a plain
 * error for malformed payloads.
 */
export async function listProviderModels(options: ListModelsOptions): Promise<RemoteModel[]> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const url = new URL(modelsUrl(options));
  if (options.protocol === 'google' && options.apiKey) url.searchParams.set('key', options.apiKey);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...authHeaders(options) },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ModelHttpError(response.status, `Model listing failed for ${url.origin}: HTTP ${response.status}`);
    }
    const payload = await response.json() as { data?: WireModel[]; models?: WireModel[] };
    const wire = payload.data ?? payload.models;
    if (!Array.isArray(wire)) throw new Error(`Unexpected model-list payload from ${url.origin}.`);
    const seen = new Set<string>();
    const models: RemoteModel[] = [];
    for (const entry of wire) {
      const model = normalizeModel(entry, options.protocol);
      if (model && !seen.has(model.id)) {
        seen.add(model.id);
        models.push(model);
      }
    }
    return models;
  } catch (error) {
    if (error instanceof ModelHttpError) throw error;
    if ((error as Error).name === 'AbortError') {
      throw new ModelHttpError(0, `Model listing timed out after ${timeoutMs}ms.`);
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

/** Sort helper for pickers: plain alphabetical, case-insensitive. */
export function sortRemoteModels(models: readonly RemoteModel[]): RemoteModel[] {
  return [...models].sort((left, right) => left.id.localeCompare(right.id));
}

/** Convenience: just the ids, sorted. */
export async function listProviderModelIds(options: ListModelsOptions): Promise<string[]> {
  return sortRemoteModels(await listProviderModels(options)).map((model) => model.id);
}

/** True when a provider definition can be probed for models. */
export function modelProviderInstanceGuard(instance: unknown): instance is ModelProvider {
  return typeof (instance as { generate?: unknown })?.generate === 'function';
}
