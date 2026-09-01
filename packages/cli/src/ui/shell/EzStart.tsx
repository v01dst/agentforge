import { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { colors } from './theme.js';
import { PROVIDER_PRESETS, getPreset, type ProviderPreset } from '../../providers-catalog.js';
import { saveCredential } from '../../credentials.js';
import { addProviderEntry } from '../../providers-store.js';
import { listProviderModels } from '@agentforge-oss/models';

/**
 * EZ start (0.8): first-run onboarding, entirely inside the TUI.
 *
 *   welcome → preset flow  (pick a provider → masked API key → live model
 *                           list from the endpoint → save + probe)
 *           → custom flow  (name → base URL → key → model id)
 *           → skip
 *
 * Keys are stored in ~/.agentforge/credentials.json (0600); the provider
 * entry lands in .agentforge/providers.json. The model list comes live from
 * the provider's own endpoint (`GET /models`) with the preset default as
 * fallback — no hardcoded model tables.
 */

export interface EzStartResult {
  name: string;
  model: string;
}

export interface EzStartProps {
  onComplete: (result: EzStartResult) => void;
  onSkip: () => void;
}

type Step =
  | { kind: 'welcome' }
  | { kind: 'preset-pick'; query: string; index: number }
  | { kind: 'preset-key'; preset: ProviderPreset; value: string }
  | { kind: 'model'; preset: ProviderPreset; entryName: string; typed: string; models: string[]; index: number; loading: boolean; error?: string }
  | { kind: 'custom'; field: 'name' | 'baseUrl' | 'key' | 'model'; name: string; baseUrl: string; key: string; model: string }
  | { kind: 'saving'; label: string }
  | { kind: 'failed'; message: string; retry: () => void; saveAnyway?: { entryName: string; preset: ProviderPreset; model: string } }
  | { kind: 'done'; name: string; model: string };

function visiblePresets(): readonly ProviderPreset[] {
  return PROVIDER_PRESETS;
}

export function EzStart({ onComplete, onSkip }: EzStartProps): React.ReactElement {
  const [step, setStep] = useState<Step>({ kind: 'welcome' });
  const busy = useRef(false);
  const pendingConfirm = useRef(false);

  useInput((value, key) => {
    if (busy.current) return;
    switch (step.kind) {
      case 'welcome': {
        if (value === '1') setStep({ kind: 'preset-pick', query: '', index: 0 });
        else if (value === '2') setStep({ kind: 'custom', field: 'name', name: '', baseUrl: '', key: '', model: '' });
        else if (value === 's' || value === 'S') onSkip();
        return;
      }
      case 'preset-pick': {
        const all = visiblePresets();
        const needle = step.query.toLowerCase();
        const matches = needle ? all.filter((preset) => `${preset.id} ${preset.label} ${preset.hint}`.toLowerCase().includes(needle)) : all;
        if (key.upArrow) { setStep({ ...step, index: Math.max(0, step.index - 1) }); return; }
        if (key.downArrow) { setStep({ ...step, index: Math.min(matches.length - 1, step.index + 1) }); return; }
        if (key.escape) { setStep({ kind: 'welcome' }); return; }
        if (key.backspace || key.delete) { setStep({ ...step, query: step.query.slice(0, -1), index: 0 }); return; }
        if (key.return && matches[step.index]) {
          const preset = matches[step.index]!;
          if (preset.local) {
            setStep({ kind: 'model', preset, entryName: preset.id, typed: preset.model, models: [], index: 0, loading: true });
            void fetchModels(preset, undefined);
          } else {
            setStep({ kind: 'preset-key', preset, value: '' });
          }
          return;
        }
        if (value && !key.ctrl && !key.meta) setStep({ ...step, query: step.query + value, index: 0 });
        return;
      }
      case 'preset-key': {
        if (key.return) {
          const key = step.value.trim();
          if (!key) return;
          setStep({ kind: 'model', preset: step.preset, entryName: step.preset.id, typed: step.preset.model, models: [], index: 0, loading: true });
          void fetchModels(step.preset, key, key);
          return;
        }
        if (key.backspace || key.delete) { setStep({ ...step, value: step.value.slice(0, -1) }); return; }
        if (key.escape) { setStep({ kind: 'preset-pick', query: '', index: 0 }); return; }
        if (value && !key.ctrl && !key.meta) setStep({ ...step, value: step.value + value });
        return;
      }
      case 'model': {
        if (step.loading) { pendingConfirm.current = true; return; }
        if (key.upArrow) { setStep({ ...step, index: Math.max(0, step.index - 1) }); return; }
        if (key.downArrow) { setStep({ ...step, index: Math.min(Math.max(step.models.length - 1, 0), step.index + 1) }); return; }
        if (key.backspace || key.delete) { setStep({ ...step, typed: step.typed.slice(0, -1), index: step.models.length }); return; }
        if (key.return) {
          const picked = step.models[step.index];
          const model = (picked ?? step.typed).trim();
          if (!model) return;
          void save(step.entryName, step.preset, model);
          return;
        }
        if (value && !key.ctrl && !key.meta) setStep({ ...step, typed: step.typed + value });
        return;
      }
      case 'custom': {
        if (key.escape) { setStep({ kind: 'welcome' }); return; }
        if (key.backspace || key.delete) {
          setStep({ ...step, [step.field]: step[step.field].slice(0, -1) } as Step);
          return;
        }
        if (key.return) {
          const advance = (next: Step): void => setStep(next);
          const current = step[step.field].trim();
          if (step.field === 'name') { if (!current) return; advance({ ...step, field: 'baseUrl', name: current }); return; }
          if (step.field === 'baseUrl') { if (!/^https?:\/\//.test(current)) return; advance({ ...step, field: 'key', baseUrl: current }); return; }
          if (step.field === 'key') { advance({ ...step, field: 'model', key: current }); return; }
          if (step.field === 'model') {
            if (!step.name || !step.baseUrl || !current) return;
            // Custom users type their model id — save directly, no picker step.
            const preset: ProviderPreset = { id: step.name, label: step.name, protocol: 'openai-compatible', baseUrl: step.baseUrl, model: current, apiKeyEnv: envForCustom(step.name), hint: 'custom provider' };
            busy.current = true;
            setStep({ kind: 'saving', label: `saving ${step.name} (${current})…` });
            void save(step.name, preset, current, step.key || undefined);
          }
          return;
        }
        if (value && !key.ctrl && !key.meta) {
          setStep({ ...step, [step.field]: step[step.field] + value } as Step);
        }
        return;
      }
      case 'failed': {
        if (value === 'r' || value === 'R') { step.retry(); return; }
        if (step.saveAnyway && (value === 's' || value === 'S')) {
          void saveForced(step.saveAnyway.entryName, step.saveAnyway.preset, step.saveAnyway.model);
        }
        return;
      }
      case 'done':
      case 'saving':
        return;
    }
  });

  async function fetchModels(preset: ProviderPreset, apiKey?: string, keyForSave?: string): Promise<void> {
    if (keyForSave) {
      await saveCredential({ entry: preset.id, env: preset.apiKeyEnv ?? envForCustom(preset.id), key: keyForSave }).catch(() => {});
      if (preset.apiKeyEnv && !(process.env[preset.apiKeyEnv])) process.env[preset.apiKeyEnv] = keyForSave;
    }
    try {
      const models = await listProviderModels({ protocol: preset.protocol, baseUrl: preset.baseUrl, apiKey });
      const ids = models.map((entry) => entry.id).slice(0, 14);
      const confirmQueued = pendingConfirm.current;
      pendingConfirm.current = false;
      let confirmed = false;
      setStep((current) => {
        if (current.kind !== 'model' || current.preset.id !== preset.id) return current;
        // A confirm pressed during loading auto-saves with the preset default.
        if (confirmQueued) { confirmed = true; }
        return { ...current, models: ids, loading: false, index: Math.max(0, ids.indexOf(preset.model)) };
      });
      if (confirmed) void save(preset.id, preset, preset.model);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStep((current) => current.kind === 'model' && current.preset.id === preset.id
        ? { ...current, loading: false, error: message, models: [] }
        : current);
    }
  }

  async function save(entryName: string, preset: ProviderPreset, model: string, apiKey?: string): Promise<void> {
    try {
      if (apiKey) {
        const envName = preset.apiKeyEnv ?? envForCustom(entryName);
        await saveCredential({ entry: entryName, env: envName, key: apiKey });
        if (!process.env[envName]) process.env[envName] = apiKey;
      }
      await addProviderEntry(entryName, {
        protocol: preset.protocol,
        model,
        baseUrl: preset.baseUrl,
        apiKeyEnv: preset.apiKeyEnv ?? envForCustom(entryName),
        force: true,
      });
      setStep({ kind: 'done', name: entryName, model });
      onComplete({ name: entryName, model });
    } catch (error) {
      busy.current = false;
      setStep({ kind: 'failed', message: error instanceof Error ? error.message : String(error), retry: () => void save(entryName, preset, model, apiKey) });
    }
  }

  async function saveForced(entryName: string, preset: ProviderPreset, model: string): Promise<void> {
    await save(entryName, preset, model);
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {renderStep(step)}
    </Box>
  );
}

function renderStep(step: Step): React.ReactElement {
  switch (step.kind) {
    case 'welcome':
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={colors.border} paddingX={1}>
          <Text bold color={colors.bannerTitle}>Welcome to AgentForge</Text>
          <Text dimColor>Connect a model to start. Pick one of three paths:</Text>
          <Text>  <Text bold color={colors.uiOk}>1</Text>  Quick start — choose a provider, paste your API key</Text>
          <Text>  <Text bold color={colors.uiOk}>2</Text>  Custom provider — base URL + API key + model id</Text>
          <Text>  <Text bold color={colors.uiOk}>s</Text>  Skip for now</Text>
        </Box>
      );
    case 'preset-pick': {
      const needle = step.query.toLowerCase();
      const matches = needle ? visiblePresets().filter((preset) => `${preset.id} ${preset.label} ${preset.hint}`.toLowerCase().includes(needle)) : visiblePresets();
      return (
        <Box flexDirection="column">
          <Text bold>Pick a provider <Text dimColor>(type to filter · enter select · esc back)</Text></Text>
          {matches.length === 0 ? <Text dimColor>  no match</Text> : matches.slice(0, 12).map((preset, index) => (
            <Text key={preset.id} color={index === step.index ? colors.accent : undefined}>
              {index === step.index ? '  ❯ ' : '    '}{preset.label.padEnd(20)}<Text dimColor> {preset.hint}</Text>
            </Text>
          ))}
          {step.query ? <Text dimColor>  filter: {step.query}</Text> : null}
        </Box>
      );
    }
    case 'preset-key':
      return (
        <Box flexDirection="column">
          <Text bold>{step.preset.label} — paste your API key <Text dimColor>(input masked · enter continue · esc back)</Text></Text>
          <Text color={colors.uiOk}>  {'•'.repeat(Math.min(step.value.length, 40))}</Text>
          <Text dimColor>  Stored in ~/.agentforge/credentials.json (0600). Never inside a project.</Text>
        </Box>
      );
    case 'model':
      return (
        <Box flexDirection="column">
          <Text bold>{step.entryName} — choose a model</Text>
          {step.loading ? <Text dimColor>  fetching models from {step.preset.baseUrl}…</Text> : null}
          {step.error && !step.loading ? (
            <Box flexDirection="column">
              <Text color={colors.error}>  ✗ could not list models: {step.error}</Text>
              <Text dimColor>  type the model id manually (preset default: {step.preset.model})</Text>
            </Box>
          ) : null}
          {!step.loading && step.models.length > 0 && step.index < step.models.length ? (
            <Box flexDirection="column">
              {step.models.map((model, index) => (
                <Text key={model} color={index === step.index ? colors.accent : undefined}>
                  {index === step.index ? '  ❯ ' : '    '}{model}
                </Text>
              ))}
              <Text dimColor>  ↑/↓ pick · or keep typing to override</Text>
            </Box>
          ) : null}
          <Text>  model: <Text color={colors.uiOk}>{step.typed}</Text><Text dimColor>▏</Text></Text>
          <Text dimColor>  enter confirm · esc restart</Text>
        </Box>
      );
    case 'custom': {
      const labels: Record<typeof step.field, string> = {
        name: 'Provider name', baseUrl: 'Base URL', key: 'API key', model: 'Model id',
      };
      const masked = step.field === 'key';
      return (
        <Box flexDirection="column">
          <Text bold>Custom provider <Text dimColor>({step.field === 'name' ? '1/4' : step.field === 'baseUrl' ? '2/4' : step.field === 'key' ? '3/4' : '4/4'})</Text></Text>
          <Text>  {labels[step.field]}: <Text color={colors.uiOk}>{masked ? '•'.repeat(Math.min(step[step.field].length, 40)) : step[step.field]}</Text><Text dimColor>▏</Text></Text>
          {step.field === 'name' ? <Text dimColor>  e.g. my-gateway (letters, digits, . _ -)</Text> : null}
          {step.field === 'baseUrl' ? <Text dimColor>  e.g. https://api.mygateway.com/v1</Text> : null}
          {step.field === 'key' ? <Text dimColor>  paste the key · enter to continue (empty = no key)</Text> : null}
          {step.field === 'model' ? <Text dimColor>  e.g. glm-5.3, deepseek-v4-flash, llama3.2</Text> : null}
          <Text dimColor>  enter next · esc restart</Text>
        </Box>
      );
    }
    case 'saving':
      return <Text dimColor>  {step.label}</Text>;
    case 'failed':
      return (
        <Box flexDirection="column">
          <Text color={colors.error}>  ✗ {step.message}</Text>
          <Text>  <Text bold color={colors.uiOk}>r</Text> retry · {step.saveAnyway ? <><Text bold color={colors.uiOk}>s</Text> save anyway · </> : null}<Text dimColor>esc back</Text></Text>
        </Box>
      );
    case 'done':
      return <Text color={colors.uiOk}>  ✓ {step.name} ready ({step.model})</Text>;
  }
}

function envForCustom(name: string): string {
  return `AGENTFORGE_CUSTOM_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_KEY`;
}

export function isKnownPreset(id: string): boolean {
  return getPreset(id) !== undefined;
}
