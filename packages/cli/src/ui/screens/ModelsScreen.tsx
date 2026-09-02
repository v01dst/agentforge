import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { buildModelReport, type ModelInfoRow } from '../../session.js';
import { loadConfig } from '../../config.js';
import {
  addProviderEntry,
  readProviderEntries,
  removeProviderEntry,
  type ProviderEntry,
} from '../../providers-store.js';
import { PROVIDER_PRESETS, getPreset, type ProviderPreset } from '../../providers-catalog.js';
import { saveCredential } from '../../credentials.js';
import { listProviderModels } from '@agentforge-oss/models';
import { type ScreenProps, badge, envState } from './screens-common.js';
import { colors } from '../shell/theme.js';

const PROTOCOLS = ['openai', 'anthropic', 'google', 'gemini', 'openai-compatible'] as const;
type Protocol = (typeof PROTOCOLS)[number];

type Tab = 'Models' | 'Endpoints' | 'Add provider';

interface AddFormState {
  name: string;
  protocolIndex: number;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
}

const emptyForm: AddFormState = { name: '', protocolIndex: 0, baseUrl: '', model: '', apiKeyEnv: '' };
const FORM_FIELDS = ['name', 'protocol', 'baseUrl', 'model', 'apiKeyEnv'] as const;

export interface ModelsScreenProps extends ScreenProps {
  /** Optional pre-loaded rows/endpoints (used by tests); loads from disk when omitted. */
  rows?: readonly ModelInfoRow[];
  endpoints?: readonly ProviderEntry[];
}

export function ModelsScreen({ onBack, rows, endpoints }: ModelsScreenProps): React.ReactElement {
  const [tab, setTab] = useState<Tab>('Models');
  const [reportRows, setReportRows] = useState<readonly ModelInfoRow[]>(rows ?? []);
  const [entries, setEntries] = useState<readonly ProviderEntry[]>(endpoints ?? []);
  const [selected, setSelected] = useState(0);
  const [detail, setDetail] = useState<ModelInfoRow | null>(null);
  const [status, setStatus] = useState<string>('');
  // add-form state
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<AddFormState>(emptyForm);
  const [formField, setFormField] = useState<number>(0);
  const [confirmDelete, setConfirmDelete] = useState<string>('');
  // Presets tab: pick a preset, paste a key (masked), fetch live models.
  const [picking, setPicking] = useState(false);
  const [presetIndex, setPresetIndex] = useState(0);
  const [presetFilter, setPresetFilter] = useState('');
  const [keyEntry, setKeyEntry] = useState<PresetKeyEntry | null>(null);

  const presetMatches = presetFilter
    ? PROVIDER_PRESETS.filter((preset) => `${preset.id} ${preset.label} ${preset.hint}`.toLowerCase().includes(presetFilter.toLowerCase()))
    : PROVIDER_PRESETS;

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        if (!rows) {
          const loaded = await loadConfig({ required: false });
          const built = buildModelReport(loaded.config?.providers ?? []);
          if (alive) setReportRows(built);
        }
        if (!endpoints) {
          const managed = await readProviderEntries();
          if (alive) setEntries(managed);
        }
      } catch (error) {
        if (alive) setStatus(`load error: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    return () => { alive = false; };
  }, [rows, endpoints]);

  useInput((input, key) => {
    if (input === 'escape') {
      if (keyEntry) { setKeyEntry(null); return; }
      if (picking) { setPicking(false); setPresetFilter(''); setPresetIndex(0); return; }
      if (detail) { setDetail(null); return; }
      if (adding) { setAdding(false); setForm(emptyForm); return; }
      onBack?.();
      return;
    }

    // Preset flow: key entry (masked) → save key + endpoint → live model list.
    if (keyEntry) {
      if (key.return) {
        const value = keyEntry.value.trim();
        if (!value && !keyEntry.preset.local) return;
        void (async () => {
          try {
            const envName = keyEntry.preset.apiKeyEnv ?? `AGENTFORGE_CUSTOM_${keyEntry.preset.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_KEY`;
            if (value) {
              await saveCredential({ entry: keyEntry.preset.id, env: envName, key: value });
              if (!process.env[envName]) process.env[envName] = value;
            }
            await addProviderEntry(keyEntry.preset.id, {
              protocol: keyEntry.preset.protocol,
              model: keyEntry.preset.model,
              baseUrl: keyEntry.preset.baseUrl,
              apiKeyEnv: envName,
              force: true,
            });
            setEntries(await readProviderEntries());
            setStatus(`${keyEntry.preset.label} saved (default model ${keyEntry.preset.model}) — fetching live models…`);
            try {
              const models = await listProviderModels({ protocol: keyEntry.preset.protocol, baseUrl: keyEntry.preset.baseUrl, apiKey: value || undefined, timeoutMs: 6000 });
              setStatus(`${keyEntry.preset.label} ready — ${models.length} live models: ${models.slice(0, 6).map((model) => model.id).join(', ')}${models.length > 6 ? ', …' : ''}`);
            } catch {
              setStatus(`${keyEntry.preset.label} ready (endpoint did not list models — default ${keyEntry.preset.model})`);
            }
            setKeyEntry(null);
            setPicking(false);
            setPresetFilter('');
            setPresetIndex(0);
            setTab('Endpoints');
            setSelected(0);
          } catch (error) {
            setStatus(`error: ${error instanceof Error ? error.message : String(error)}`);
          }
        })();
        return;
      }
      if (key.backspace || key.delete) { setKeyEntry({ ...keyEntry, value: keyEntry.value.slice(0, -1) }); return; }
      if (input && input.length >= 1 && !key.ctrl && !key.meta) {
        setKeyEntry({ ...keyEntry, value: keyEntry.value + input });
      }
      return;
    }

    // Presets tab: filter + pick.
    if (picking) {
      if (key.upArrow) { setPresetIndex((index) => Math.max(0, index - 1)); return; }
      if (key.downArrow) { setPresetIndex((index) => Math.min(Math.max(presetMatches.length - 1, 0), index + 1)); return; }
      if (key.backspace || key.delete) { setPresetFilter((value) => value.slice(0, -1)); setPresetIndex(0); return; }
      if (key.return && presetMatches[presetIndex]) {
        const preset = presetMatches[presetIndex]!;
        setKeyEntry({ preset, value: '' });
        return;
      }
      if (input && input.length >= 1 && !key.ctrl && !key.meta) {
        setPresetFilter((value) => value + input);
        setPresetIndex(0);
      }
      return;
    }

    if (detail) return; // detail panel closes only via Esc
    if (key.leftArrow || key.rightArrow) {
      const order: Tab[] = ['Models', 'Endpoints', 'Add provider'];
      const currentIndex = order.indexOf(tab);
      const next = key.rightArrow ? (currentIndex + 1) % order.length : (currentIndex + order.length - 1) % order.length;
      setTab(order[next]!);
      setSelected(0);
      setConfirmDelete('');
      return;
    }

    if (adding) {
      if (key.tab || key.return && formField < FORM_FIELDS.length - 1) {
        setFormField((f) => (f + 1) % FORM_FIELDS.length);
        return;
      }
      if (key.upArrow) { setFormField((f) => (f + FORM_FIELDS.length - 1) % FORM_FIELDS.length); return; }
      if (key.downArrow) { setFormField((f) => (f + 1) % FORM_FIELDS.length); return; }
      if (key.return && formField === FORM_FIELDS.length - 1) {
        const protocol = PROTOCOLS[form.protocolIndex] as Protocol;
        void addProviderEntry(form.name, {
          protocol,
          baseUrl: form.baseUrl || undefined,
          model: form.model || undefined,
          apiKeyEnv: form.apiKeyEnv || undefined,
        })
          .then(async () => {
            setEntries(await readProviderEntries());
            setStatus(`endpoint '${form.name}' saved`);
          })
          .catch((error: unknown) => setStatus(`error: ${error instanceof Error ? error.message : String(error)}`));
        setAdding(false);
        setForm(emptyForm);
        return;
      }
      if (key.backspace || key.delete) {
        setForm((f) => editFormText(f, formField, undefined));
        return;
      }
      if (input && input.length >= 1 && !key.ctrl && !key.meta) {
        if (FORM_FIELDS[formField] === 'protocol') {
          if (key.upArrow) return;
          setForm((f) => ({ ...f, protocolIndex: (f.protocolIndex + 1) % PROTOCOLS.length }));
        } else {
          setForm((f) => editFormText(f, formField, input));
        }
        return;
      }
      return;
    }

    // 'Add provider' tab: enter opens the preset picker (the full catalog).
    if (tab === 'Add provider' && key.return) {
      setPicking(true);
      setPresetIndex(0);
      return;
    }

    const listLength = tab === 'Models' ? reportRows.length : entries.length;
    if (listLength > 0) {
      if (key.upArrow) { setSelected((s) => (s + listLength - 1) % listLength); return; }
      if (key.downArrow) { setSelected((s) => (s + 1) % listLength); return; }
    }
    if (key.return && tab === 'Models') {
      setDetail(reportRows[selected] ?? null);
      return;
    }
    if (key.return && tab === 'Endpoints' && entries[selected]) {
      const name = entries[selected]!.name;
      if (confirmDelete === name) {
        void removeProviderEntry(name)
          .then(async () => {
            setEntries(await readProviderEntries());
            setStatus(`endpoint '${name}' removed`);
          })
          .catch((error: unknown) => setStatus(`error: ${error instanceof Error ? error.message : String(error)}`));
        setConfirmDelete('');
        return;
      }
      setConfirmDelete(name);
      setStatus(`press enter again to remove '${name}'`);
      return;
    }
  });

  const tabletWidth = 100;
  return (
    <Box flexDirection="column" paddingX={2} paddingTop={1}>
      <Text bold color={colors.bannerTitle}>𓂀 Models & Providers 𓋴</Text>
      <Text color={colors.dim}>{'  '}←/→ tabs · enter act · esc back{'\n'}</Text>
      <Box gap={2}>
        <Text color={tab === 'Models' ? colors.label : colors.dim}>{tab === 'Models' ? '▸ ' : '  '}Models</Text>
        <Text color={tab === 'Endpoints' ? colors.label : colors.dim}>{tab === 'Endpoints' ? '▸ ' : '  '}Endpoints</Text>
        <Text color={tab === 'Add provider' ? colors.label : colors.dim}>{tab === 'Add provider' ? '▸ ' : '  '}Add provider</Text>
      </Box>
      <Text color={colors.border}>{'─'.repeat(tabletWidth)}</Text>

      {keyEntry ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{keyEntry.preset.label} — paste your API key <Text dimColor>(masked · enter save · esc back)</Text></Text>
          <Text color={colors.uiOk}>  {'•'.repeat(Math.min(keyEntry.value.length, 40))}</Text>
          {keyEntry.preset.local ? <Text dimColor>  local runtime — no key needed; press enter to save</Text> : null}
        </Box>
      ) : picking ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Choose a provider <Text dimColor>({PROVIDER_PRESETS.length} presets — type to filter · enter select · esc back)</Text></Text>
          {presetMatches.length === 0 ? <Text dimColor>  no match</Text> : presetMatches.map((preset, index) => (
            <Text key={preset.id} color={index === presetIndex ? colors.label : colors.dim}>
              {index === presetIndex ? '  ❯ ' : '    '}{preset.label.padEnd(20)} {preset.hint}
            </Text>
          ))}
          {presetFilter ? <Text dimColor>  filter: {presetFilter}</Text> : null}
        </Box>
      ) : adding ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Custom endpoint (advanced) <Text dimColor>— presets are on the 'Add provider' tab</Text></Text>
          {FORM_FIELDS.map((field, index) => (
            <Text key={field} color={index === formField ? colors.label : colors.dim}>
              {index === formField ? '  ❯ ' : '    '}{field.padEnd(10)}{field === 'protocol' ? PROTOCOLS[form.protocolIndex] : (form[field] || '…')}
            </Text>
          ))}
        </Box>
      ) : tab === 'Add provider' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>  <Text bold color={colors.label}>enter</Text> <Text dimColor>— open the provider catalog ({PROVIDER_PRESETS.length} presets: OpenRouter, DeepSeek, Groq, xAI, Mistral, Together, Fireworks, Cerebras, Moonshot/Kimi, Z.AI/GLM, Perplexity, Ollama, LM Studio, and the big three).</Text></Text>
          <Text>  <Text bold color={colors.label}>e</Text> <Text dimColor>— advanced: custom OpenAI-compatible endpoint (name → protocol → base URL → model → key env)</Text></Text>
          <Text dimColor>  keys are stored in ~/.agentforge/credentials.json (0600) — never inside a project</Text>
          {status ? <Text color={colors.uiOk}>{'  '}{status}</Text> : null}
        </Box>
      ) : tab === 'Models' ? (
        <Box flexDirection="column" marginTop={1}>
          {reportRows.length === 0 ? <Text dimColor>  (no providers configured — see the 'Add provider' tab)</Text> : reportRows.map((row, index) => (
            <Text key={`${row.provider}-${index}`} color={index === selected ? colors.label : undefined}>
              {index === selected ? '  ❯ ' : '    '}{badge(envState(row.provider))} {row.provider.padEnd(14)} <Text dimColor>{row.description}{row.defaultModel ? ` · ${row.defaultModel}` : ''}</Text>
            </Text>
          ))}
          {detail ? (
            <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={colors.border} paddingX={1}>
              <Text bold>{detail.provider}</Text>
              <Text dimColor>{detail.description}</Text>
              <Text>default model: {detail.defaultModel ?? '(none)'}</Text>
              <Text dimColor>live model lists are fetched during provider setup (EzStart / Add provider)</Text>
            </Box>
          ) : null}
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {entries.length === 0 ? <Text dimColor>  (no saved endpoints yet — 'Add provider' tab)</Text> : entries.map((entry, index) => (
            <Text key={entry.name} color={index === selected ? colors.label : undefined}>
              {index === selected ? '  ❯ ' : '    '}{entry.name.padEnd(14)} <Text dimColor>{entry.protocol}{entry.model ? ` · ${entry.model}` : ''}{entry.apiKeyEnv ? ` · ${entry.apiKeyEnv}` : ''}</Text>
              {confirmDelete === entry.name ? <Text color={colors.error}>  [enter again to remove]</Text> : null}
            </Text>
          ))}
          {status ? <Text color={colors.uiOk}>{'  '}{status}</Text> : null}
        </Box>
      )}
    </Box>
  );
}

interface PresetKeyEntry {
  preset: ProviderPreset;
  value: string;
}

function editFormText(form: AddFormState, field: number, input: string | undefined): AddFormState {
  const name = FORM_FIELDS[field];
  if (!name || name === 'protocol') return form;
  const current = form[name];
  return { ...form, [name]: input === undefined ? current.slice(0, -1) : current + input };
}

