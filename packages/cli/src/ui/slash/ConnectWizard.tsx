import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { setGlobalDefault, validateProviderConnection } from './local-global-config.js';

/**
 * Interactive provider setup wizard. Works with zero project.
 * Secrets are never rendered: input is masked ('*' per char) and only
 * environment variable NAMES are shown.
 */

type ProviderChoice = 'openai' | 'anthropic' | 'google' | 'openai-compatible';

const PROVIDER_OPTIONS: ReadonlyArray<{ id: ProviderChoice; label: string }> = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'google', label: 'Google Gemini' },
  { id: 'openai-compatible', label: 'OpenAI-compatible / custom' },
];

const DEFAULT_ENV: Record<ProviderChoice, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
  'openai-compatible': 'OPENAI_API_KEY',
};

interface WizardState {
  provider?: ProviderChoice;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  model?: string;
  persisted?: boolean;
}

type Step = 'provider' | 'credential' | 'persist' | 'custom-base-url' | 'custom-model' | 'custom-env' | 'validate' | 'done';

export function ConnectWizard({ onBack }: { onBack?: () => void }): React.ReactElement {
  const [step, setStep] = useState<Step>('provider');
  const [providerIndex, setProviderIndex] = useState(0);
  const [input, setInput] = useState('');
  const [state, setState] = useState<WizardState>({});
  const [validation, setValidation] = useState<{ ready: boolean; reason?: string; fix?: string } | null>(null);

  function goBack(): void {
    if (step === 'provider') { onBack?.(); return; }
    if (step === 'done') { setStep('provider'); return; }
    if (step === 'validate') { setStep(state.provider === 'openai-compatible' ? 'custom-env' : 'persist'); return; }
    if (step === 'custom-env') { setStep('custom-model'); return; }
    if (step === 'custom-model') { setStep('custom-base-url'); return; }
    if (step === 'custom-base-url') { setStep('persist'); return; }
    if (step === 'persist') { setStep('credential'); return; }
    setStep('provider');
  }

  function applyCredential(value: string): void {
    if (!state.provider) return;
    const envName = state.apiKeyEnv ?? DEFAULT_ENV[state.provider];
    // Store in the session environment only; never printed back.
    process.env[envName] = value;
    setState((prev) => ({ ...prev, apiKey: value, apiKeyEnv: envName }));
    setInput('');
    setStep(state.provider === 'openai-compatible' ? 'custom-base-url' : 'persist');
  }

  function runValidation(): void {
    if (!state.provider) return;
    const result = validateProviderConnection({
      provider: state.provider,
      apiKeyEnv: state.apiKeyEnv,
      baseUrl: state.baseUrl,
      live: false,
    });
    setValidation(result);
    setStep(result.ready ? 'done' : 'validate');
  }

  useInput((value, key) => {
    // Esc anywhere goes back a step; Ctrl+C exits the flow.
    if (key.escape) { goBack(); return; }
    if (key.ctrl && value === 'c') { onBack?.(); return; }

    switch (step) {
      case 'provider': {
        if (key.upArrow) setProviderIndex((i) => Math.max(0, i - 1));
        else if (key.downArrow) setProviderIndex((i) => Math.min(PROVIDER_OPTIONS.length - 1, i + 1));
        else if (key.return) {
          const choice = PROVIDER_OPTIONS[providerIndex]!;
          setState({ provider: choice.id });
          setInput('');
          setStep('credential');
        }
        return;
      }
      case 'credential': {
        if (key.return) applyCredential(input);
        else if (key.backspace || key.delete) setInput((v) => v.slice(0, -1));
        else if (value && !key.ctrl && !key.meta) setInput((v) => v + value);
        return;
      }
      case 'persist': {
        if (value === 'y' || value === 'Y') {
          if (state.provider) setGlobalDefault({ provider: state.provider, model: state.model });
          setState((prev) => ({ ...prev, persisted: true }));
          setStep(state.provider === 'openai-compatible' ? 'custom-base-url' : 'validate');
        } else if (value === 'n' || value === 'N' || key.return) {
          setState((prev) => ({ ...prev, persisted: false }));
          setStep(state.provider === 'openai-compatible' ? 'custom-base-url' : 'validate');
        }
        return;
      }
      case 'custom-base-url': {
        if (key.return && input.trim()) {
          setState((prev) => ({ ...prev, baseUrl: input.trim() }));
          setInput('');
          setStep('custom-model');
        } else if (key.backspace || key.delete) setInput((v) => v.slice(0, -1));
        else if (value && !key.ctrl && !key.meta) setInput((v) => v + value);
        return;
      }
      case 'custom-model': {
        if (key.return && input.trim()) {
          setState((prev) => ({ ...prev, model: input.trim() }));
          setInput('');
          setStep('custom-env');
        } else if (key.backspace || key.delete) setInput((v) => v.slice(0, -1));
        else if (value && !key.ctrl && !key.meta) setInput((v) => v + value);
        return;
      }
      case 'custom-env': {
        if (key.return) {
          const envName = input.trim() || DEFAULT_ENV['openai-compatible'];
          setState((prev) => ({ ...prev, apiKeyEnv: envName }));
          setInput('');
          setStep('validate');
        } else if (key.backspace || key.delete) setInput((v) => v.slice(0, -1));
        else if (value && !key.ctrl && !key.meta) setInput((v) => v + value);
        return;
      }
      case 'validate': {
        if (validation?.ready || key.return) runValidation();
        return;
      }
      case 'done': {
        if (key.return) onBack?.();
        return;
      }
    }
  });

  const masked = (length: number): string => '*'.repeat(length);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Connect a provider</Text>
      <Text dimColor>↑/↓ select · enter confirm · Esc back a step · Ctrl+C exit wizard</Text>

      {step === 'provider' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Choose a provider:</Text>
          {PROVIDER_OPTIONS.map((option, index) => (
            <Text key={option.id} color={index === providerIndex ? 'cyan' : undefined}>
              {index === providerIndex ? '❯ ' : '  '}
              {option.label}
            </Text>
          ))}
        </Box>
      ) : null}

      {step === 'credential' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Credential for {PROVIDER_OPTIONS.find((o) => o.id === state.provider)?.label}</Text>
          <Text>
            Enter a value for <Text color="yellow">{state.apiKeyEnv ?? (state.provider ? DEFAULT_ENV[state.provider] : '')}</Text>{' '}
            (stored in the session environment; never displayed):
          </Text>
          <Text>{masked(input.length)}▏</Text>
          <Text dimColor>enter to save</Text>
        </Box>
      ) : null}

      {step === 'persist' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>Persist as cross-project default? (y/n)</Text>
          <Text dimColor>y → writes defaultProvider to the global config · n → session only</Text>
        </Box>
      ) : null}

      {step === 'custom-base-url' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Base URL</Text>
          <Text>e.g. https://openrouter.ai/api/v1</Text>
          <Text>{input}▏</Text>
        </Box>
      ) : null}

      {step === 'custom-model' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Model id</Text>
          <Text dimColor>e.g. meta-llama/llama-3.1-70b-instruct</Text>
          <Text>{input}▏</Text>
        </Box>
      ) : null}

      {step === 'custom-env' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Environment variable name for the API key</Text>
          <Text dimColor>default: OPENAI_API_KEY (enter to accept)</Text>
          <Text>{input}▏</Text>
        </Box>
      ) : null}

      {step === 'validate' ? (
        <Box flexDirection="column" marginTop={1}>
          {!validation ? (
            <Text dimColor>press enter to validate…</Text>
          ) : validation.ready ? (
            <Text color="green">✓ ready — credentials detected for {state.provider}</Text>
          ) : (
            <>
              <Text color="yellow">! not ready — {validation.reason}</Text>
              <Text dimColor>fix: {validation.fix ?? 'run /connect again'}</Text>
              <Text dimColor>{`e.g. export ${state.apiKeyEnv ?? 'the key'} — or re-enter it in the wizard`}</Text>
            </>
          )}
        </Box>
      ) : null}

      {step === 'done' ? (
        <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
          <Text bold color="green">Provider connected</Text>
          <Text>provider: {state.provider}</Text>
          {state.model ? <Text>model: {state.model}</Text> : null}
          {state.baseUrl ? <Text>base url: {state.baseUrl}</Text> : null}
          <Text>credential: stored in ${state.apiKeyEnv ?? '(env)'} (value hidden)</Text>
          <Text>persisted as default: {state.persisted ? 'yes' : 'no (session only)'}</Text>
          <Text dimColor>press enter to return</Text>
        </Box>
      ) : null}
    </Box>
  );
}
