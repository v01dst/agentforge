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
import { type ScreenProps, badge, envState } from './screens-common.js';

const PROTOCOLS = ['openai', 'anthropic', 'google', 'gemini', 'openai-compatible'] as const;
type Protocol = (typeof PROTOCOLS)[number];

type Tab = 'Models' | 'Endpoints';

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
      if (detail) { setDetail(null); return; }
      if (adding) { setAdding(false); setForm(emptyForm); return; }
      onBack?.();
      return;
    }
    if (detail) return; // detail panel closes only via Esc
    if (key.leftArrow) { setTab('Models'); setSelected(0); return; }
    if (key.rightArrow) { setTab('Endpoints'); setSelected(0); setConfirmDelete(''); return; }

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

    const listLength = tab === 'Models' ? reportRows.length : entries.length;
    if (listLength > 0) {
      if (key.upArrow) { setSelected((s) => (s + listLength - 1) % listLength); return; }
      if (key.downArrow) { setSelected((s) => (s + 1) % listLength); return; }
    }
    if (key.return && tab === 'Models') {
      setDetail(reportRows[selected] ?? null);
      return;
    }
    if (tab === 'Endpoints') {
      const current = entries[selected];
      if (input === 'a') {
        setAdding(true);
        setForm(emptyForm);
        setFormField(0);
        setConfirmDelete('');
        return;
      }
      if (input === 'd' && current) {
        if (confirmDelete === current.name) {
          void removeProviderEntry(current.name)
            .then(async (removed: boolean) => {
              setEntries(await readProviderEntries());
              setSelected(0);
              setStatus(removed ? `endpoint '${current.name}' removed` : `endpoint '${current.name}' not found`);
            })
            .catch((error: unknown) => setStatus(`error: ${error instanceof Error ? error.message : String(error)}`));
          setConfirmDelete('');
        } else {
          setConfirmDelete(current.name);
          setStatus(`press d again to confirm deleting '${current.name}'`);
        }
      }
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Models &amp; Providers</Text>
      {!adding && (
        <Text>
          [{tab === 'Models' ? 'x' : ' '}] Models {' '}
          [{tab === 'Endpoints' ? 'x' : ' '}] Endpoints {' '}
          <Text dimColor>(←/→ tabs)</Text>
        </Text>
      )}
      {status ? <Text color="cyan">{status}</Text> : null}

      {!adding && tab === 'Models' && !detail && reportRows.map((row, index) => (
        <Text key={row.provider} color={index === selected ? 'cyan' : undefined}>
          {index === selected ? '❯ ' : '  '}
          {row.provider.padEnd(18)} {(row.protocol ?? row.source).padEnd(18)}{' '}
          {badge(row.ready)} {row.defaultModel ?? '(default model unset)'}
        </Text>
      ))}

      {!adding && tab === 'Models' && detail && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
          <Text bold>{detail.provider}</Text>
          <Text>description: {detail.description}</Text>
          <Text>protocol/source: {detail.protocol ?? detail.source}</Text>
          <Text>baseUrl: {detail.baseUrl ?? '(none)'}</Text>
          <Text>default model: {detail.defaultModel ?? '(unset)'}</Text>
          <Text>
            credential: {detail.envVars.length
              ? `${detail.envVars.join(', ')} [${envState(detail.envVars[0]) ? 'set ✓' : 'missing !'}]`
              : '(none required)'}
          </Text>
          <Text dimColor>Esc to close</Text>
        </Box>
      )}

      {!adding && tab === 'Endpoints' && (entries.length === 0
        ? <Text dimColor>No managed endpoints. Press a to add one.</Text>
        : entries.map((entry, index) => (
          <Text key={entry.name} color={index === selected ? 'cyan' : undefined}>
            {index === selected ? '❯ ' : '  '}
            {entry.name.padEnd(18)} {entry.protocol.padEnd(18)}{' '}
            {entry.apiKeyEnv
              ? `${entry.apiKeyEnv} [${envState(entry.apiKeyEnv) ? 'set ✓' : 'missing !'}]`
              : '[no key env]'}{' '}
            {entry.baseUrl ?? ''}
          </Text>
        )))}
      {!adding && tab === 'Endpoints' && entries.length > 0 && (
        <Text dimColor>a: add · d: delete · Esc: back</Text>
      )}

      {adding && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
          <Text bold>Add endpoint</Text>
          {FORM_FIELDS.map((field, index) => {
            const active = index === formField;
            const value = field === 'protocol'
              ? PROTOCOLS[form.protocolIndex]
              : field === 'name' ? form.name
              : field === 'baseUrl' ? form.baseUrl
              : field === 'model' ? form.model
              : form.apiKeyEnv;
            return (
              <Text key={field} color={active ? 'cyan' : undefined}>
                {active ? '❯ ' : '  '}
                {field === 'apiKeyEnv' ? 'api-key-env' : field}: {value}{active ? '▏' : ''}
                {field === 'protocol' && active ? ' (←/→ or type to cycle)' : ''}
              </Text>
            );
          })}
          <Text dimColor>tab/down: next · enter on last field saves · Esc cancels</Text>
        </Box>
      )}
    </Box>
  );
}

function editFormText(form: AddFormState, field: number, insertion: string | undefined): AddFormState {
  switch (FORM_FIELDS[field]) {
    case 'name': return { ...form, name: applyEdit(form.name, insertion) };
    case 'baseUrl': return { ...form, baseUrl: applyEdit(form.baseUrl, insertion) };
    case 'model': return { ...form, model: applyEdit(form.model, insertion) };
    case 'apiKeyEnv': return { ...form, apiKeyEnv: applyEdit(form.apiKeyEnv, insertion) };
    default: return form;
  }
}

function applyEdit(current: string, insertion: string | undefined): string {
  if (insertion === undefined) return current.slice(0, -1);
  return current + insertion;
}
