import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { PERMISSION_MODES, currentPermissionMode, setPermissionMode } from '../../permissions-state.js';
import { readProviderEntries } from '../../providers-store.js';
import { BUILTIN_PROVIDERS, type ScreenProps } from './screens-common.js';

export function SettingsScreen({ onBack }: ScreenProps): React.ReactElement {
  const [endpoints, setEndpoints] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [modelInput, setModelInput] = useState('');
  const [editingModel, setEditingModel] = useState(false);
  const [confirmation, setConfirmation] = useState('');

  // Managed endpoint names are loaded lazily on first down-arrow into the list region.
  React.useEffect(() => {
    let alive = true;
    void readProviderEntries()
      .then((entries) => { if (alive) setEndpoints(entries.map((entry) => entry.name)); })
      .catch(() => { /* endpoints list stays empty */ });
    return () => { alive = false; };
  }, []);

  const providers: readonly string[] = [...BUILTIN_PROVIDERS, ...endpoints];
  const permissionOffset = providers.length + 1; // + model input row

  const confirm = (message: string): void => setConfirmation(message);

  useInput((input, key) => {
    if (input === 'escape') {
      if (editingModel) { setEditingModel(false); return; }
      onBack?.();
      return;
    }
    if (editingModel) {
      if (key.backspace || key.delete) { setModelInput((value) => value.slice(0, -1)); return; }
      if (key.return) {
        process.env.AGENTFORGE_MODEL = modelInput;
        setEditingModel(false);
        confirm(`AGENTFORGE_MODEL=${modelInput}`);
        return;
      }
      if (input && input.length >= 1 && !key.ctrl && !key.meta) setModelInput((value) => value + input);
      return;
    }
    if (key.upArrow) { setSelected((s) => Math.max(0, s - 1)); return; }
    if (key.downArrow) { setSelected((s) => s + 1); return; }

    if (selected < providers.length) {
      if (key.return) {
        const provider = providers[selected];
        process.env.AGENTFORGE_PROVIDER = provider;
        confirm(`AGENTFORGE_PROVIDER=${provider}`);
      }
      return;
    }
    if (selected === providers.length) {
      if (key.return) setEditingModel(true);
      return;
    }
    // permission mode rows
    const index = selected - permissionOffset;
    if ((key.return || key.leftArrow || key.rightArrow) && index >= 0 && index < PERMISSION_MODES.length) {
      const mode = PERMISSION_MODES[index] as (typeof PERMISSION_MODES)[number];
      setPermissionMode(mode);
      confirm(`permission mode: ${mode}`);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Session Settings</Text>
      {confirmation ? <Text color="green">{confirmation}</Text> : null}
      <Text dimColor>↑/↓ select · enter apply · Esc back</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Provider</Text>
        {providers.map((provider, index) => (
          <Text key={provider} color={index === selected ? 'cyan' : undefined}>
            {index === selected ? '❯ ' : '  '}
            [{process.env.AGENTFORGE_PROVIDER === provider ? 'x' : ' '}] {provider}
            {index >= BUILTIN_PROVIDERS.length ? ' (managed endpoint)' : ''}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text color={selected === providers.length ? 'cyan' : undefined}>
          {selected === providers.length ? '❯ ' : '  '}
          Model: {editingModel ? `${modelInput}▏` : (process.env.AGENTFORGE_MODEL ?? '(unset)')} — enter to edit
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Permission mode</Text>
        {PERMISSION_MODES.map((mode, index) => (
          <Text key={mode} color={permissionOffset + index === selected ? 'cyan' : undefined}>
            {permissionOffset + index === selected ? '❯ ' : '  '}
            [{currentPermissionMode() === mode ? 'x' : ' '}] {mode}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Credentials are never written to disk; use agentforge connect &lt;provider&gt; or export env vars.</Text>
      </Box>
    </Box>
  );
}
