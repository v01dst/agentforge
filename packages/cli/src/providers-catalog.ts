/**
 * Provider catalog (0.8): built-in presets for the providers users actually
 * bring. Every remote preset speaks the OpenAI chat-completions protocol
 * (Anthropic, Google, and OpenAI native where the provider is native);
 * local runtimes (Ollama, LM Studio) need no key. Base URLs and default
 * model ids are presets — users can override the model at setup time.
 */

export interface ProviderPreset {
  /** Preset id used in `agentforge providers add` and the TUI picker. */
  id: string;
  /** Human label shown in the picker. */
  label: string;
  protocol: 'openai' | 'anthropic' | 'google' | 'openai-compatible';
  baseUrl: string;
  /** Default model id (editable during setup). */
  model: string;
  /** Env var consulted first for the key (Ollama/LM Studio need none). */
  apiKeyEnv?: string;
  /** True for local runtimes: no key, no probe beyond reachability. */
  local?: boolean;
  /** One-liner shown in the picker. */
  hint: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  // Defaults verified against provider docs 2026-09: model ids are editable at setup.
  { id: 'openai', label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol', apiKeyEnv: 'OPENAI_API_KEY', hint: 'GPT-5.6 Sol / Terra / Luna · platform.openai.com' },
  { id: 'anthropic', label: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-5', apiKeyEnv: 'ANTHROPIC_API_KEY', hint: 'Opus 5 · Fable 5 · Sonnet 5 · Haiku 4.5' },
  { id: 'google', label: 'Google Gemini', protocol: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash', apiKeyEnv: 'GEMINI_API_KEY', hint: 'Gemini family · aistudio.google.com' },
  { id: 'openrouter', label: 'OpenRouter', protocol: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/auto', apiKeyEnv: 'OPENROUTER_API_KEY', hint: 'Every model, one key · openrouter.ai/models' },
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai-compatible', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', apiKeyEnv: 'DEEPSEEK_API_KEY', hint: 'V4 Flash / V4 Pro · api.deepseek.com' },
  { id: 'groq', label: 'Groq', protocol: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', apiKeyEnv: 'GROQ_API_KEY', hint: 'Fastest open-model inference' },
  { id: 'xai', label: 'xAI (Grok)', protocol: 'openai-compatible', baseUrl: 'https://api.x.ai/v1', model: 'grok-4.6', apiKeyEnv: 'XAI_API_KEY', hint: 'Grok 4.6 · console.x.ai' },
  { id: 'mistral', label: 'Mistral', protocol: 'openai-compatible', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-medium-2604', apiKeyEnv: 'MISTRAL_API_KEY', hint: 'Medium 3.5 · Large 3 · Codestral' },
  { id: 'together', label: 'Together AI', protocol: 'openai-compatible', baseUrl: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', apiKeyEnv: 'TOGETHER_API_KEY', hint: 'Open-model cloud · api.together.xyz' },
  { id: 'fireworks', label: 'Fireworks AI', protocol: 'openai-compatible', baseUrl: 'https://api.fireworks.ai/inference/v1', model: 'accounts/fireworks/models/llama-v3p3-70b-instruct', apiKeyEnv: 'FIREWORKS_API_KEY', hint: 'Fast open-model serving' },
  { id: 'cerebras', label: 'Cerebras', protocol: 'openai-compatible', baseUrl: 'https://api.cerebras.ai/v1', model: 'llama-3.3-70b', apiKeyEnv: 'CEREBRAS_API_KEY', hint: 'Wafer-scale speed' },
  { id: 'moonshot', label: 'Moonshot (Kimi)', protocol: 'openai-compatible', baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k3', apiKeyEnv: 'MOONSHOT_API_KEY', hint: 'Kimi K3 flagship · platform.kimi.ai' },
  { id: 'zai', label: 'Z.AI (GLM)', protocol: 'openai-compatible', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-5.3', apiKeyEnv: 'ZAI_API_KEY', hint: 'GLM-5.3 · GLM-5.3-Flash · z.ai' },
  { id: 'perplexity', label: 'Perplexity', protocol: 'openai-compatible', baseUrl: 'https://api.perplexity.ai', model: 'sonar-pro', apiKeyEnv: 'PERPLEXITY_API_KEY', hint: 'Sonar online models' },
  { id: 'ollama', label: 'Ollama (local)', protocol: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2', local: true, hint: 'Local runtime — no key needed' },
  { id: 'lmstudio', label: 'LM Studio (local)', protocol: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', model: 'local-model', local: true, hint: 'Local runtime — no key needed' },
];

export function getPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/** Presets that need an API key (used by ez-start filtering). */
export function remotePresets(): ProviderPreset[] {
  return PROVIDER_PRESETS.filter((preset) => !preset.local);
}

export function localPresets(): ProviderPreset[] {
  return PROVIDER_PRESETS.filter((preset) => preset.local);
}
