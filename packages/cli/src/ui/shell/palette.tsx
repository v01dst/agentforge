import { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { colors } from './theme.js';

/** A single palette action. */
export interface PaletteAction {
  id: string;
  title: string;
  hint?: string;
  run: () => void | Promise<void>;
}

/**
 * Filterable command palette. Type-to-filter (case-insensitive substring on
 * title+hint), up/down to move, enter to run, esc to close.
 */
export function CommandPalette({ actions, onClose }: { actions: readonly PaletteAction[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [running, setRunning] = useState(false);

  const filtered = useMemo(() => {
    const needle = query.toLowerCase();
    if (!needle) return [...actions];
    return actions.filter((action) => `${action.title} ${action.hint ?? ''}`.toLowerCase().includes(needle));
  }, [actions, query]);

  const clamped = Math.min(index, Math.max(filtered.length - 1, 0));

  useInput((input, key) => {
    if (running) return;
    if (key.escape) { onClose(); return; }
    if (key.upArrow) { setIndex(Math.max(clamped - 1, 0)); return; }
    if (key.downArrow) { setIndex(Math.min(clamped + 1, filtered.length - 1)); return; }
    if (key.return) {
      const action = filtered[clamped];
      if (!action) return;
      setRunning(true);
      void Promise.resolve(action.run()).finally(onClose);
      return;
    }
    if (key.backspace || key.delete) { setQuery(query.slice(0, -1)); setIndex(0); return; }
    if (input && !key.ctrl && !key.meta) { setQuery(query + input); setIndex(0); }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={1}>
      <Text color={colors.accent}>Command Palette</Text>
      <Text>filter: {query}<Text dimColor>_</Text></Text>
      {filtered.length === 0 ? (
        <Text dimColor>(no matching commands)</Text>
      ) : (
        filtered.map((action, position) => {
          const selected = position === clamped;
          return (
            <Text key={action.id} color={selected ? colors.accent : undefined}>
              {selected ? '\u203a ' : '  '}{action.title}{action.hint ? ` ${action.hint}` : ''}
            </Text>
          );
        })
      )}
      <Text dimColor>{'type to filter \u00b7 up/down move \u00b7 enter run \u00b7 esc close'}</Text>
    </Box>
  );
}
