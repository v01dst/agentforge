import { describe, expect, it } from 'vitest';
import { resolveRequestedModel, SUPPORTED_PROTOCOLS } from '../lib/providers';

const env = (values: Record<string, string>) => ({ ...values } as NodeJS.ProcessEnv);

describe('playground model selection', () => {
  it('defaults to the deterministic mock provider', () => {
    const result = resolveRequestedModel({});
    expect('model' in result && result.model.provider).toBe('mock');
  });

  it('rejects unknown providers with available options', () => {
    const result = resolveRequestedModel({ provider: 'carrier-pigeon' });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain("Unsupported provider 'carrier-pigeon'");
      expect(result.error).toContain('openai-compatible');
    }
  });

  it('requires a base URL for openai-compatible endpoints', () => {
    const result = resolveRequestedModel({ provider: 'openai-compatible', model: 'vendor/x' }, env({}));
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toMatch(/requires a base URL/);
  });

  it('names the missing credential environment variable', () => {
    const missing = resolveRequestedModel({ provider: 'anthropic' }, env({}));
    expect('error' in missing).toBe(true);
    if ('error' in missing) expect(missing.error).toContain('ANTHROPIC_API_KEY');

    const custom = resolveRequestedModel({ provider: 'openai-compatible', baseUrl: 'https://p.example/v1', apiKeyEnv: 'MY_KEY' }, env({}));
    expect('error' in custom).toBe(true);
    if ('error' in custom) expect(custom.error).toContain('MY_KEY');
  });

  it('builds a real adapter when configuration and credentials are present', () => {
    const result = resolveRequestedModel(
      { provider: 'openai-compatible', baseUrl: 'https://p.example/v1', model: 'vendor/x', apiKeyEnv: 'MY_KEY' },
      env({ MY_KEY: 'secret' }),
    );
    expect('model' in result).toBe(true);
    if ('model' in result) expect(result.model.provider).toBe('openai');

    const builtin = resolveRequestedModel({ provider: 'google' }, env({ GOOGLE_API_KEY: 'g' }));
    expect('model' in builtin && builtin.model.provider).toBe('google');
  });

  it('never echoes resolved secrets in errors', () => {
    const result = resolveRequestedModel({ provider: 'openai-compatible', baseUrl: 'https://p.example/v1', apiKeyEnv: 'SECRET_VAR_NAME' }, env({}));
    if ('error' in result) {
      expect(result.error).toContain('SECRET_VAR_NAME');
      // The variable NAME is fine; there is no value to leak when unset.
      expect(result.error).not.toMatch(/Bearer\s/);
    }
    expect(SUPPORTED_PROTOCOLS).toContain('gemini');
  });
});
