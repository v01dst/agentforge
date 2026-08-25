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

/** True when every character of `query` appears in `target` in order (case-insensitive). */
export function fuzzyMatch(query: string, target: string): boolean {
  const needle = query.toLowerCase();
  const haystack = target.toLowerCase();
  if (!needle) return true;
  let cursor = 0;
  for (const character of needle) {
    cursor = haystack.indexOf(character, cursor);
    if (cursor === -1) return false;
    cursor += 1;
  }
  return true;
}

/**
 * Rank a fuzzy match. Empty query scores 0, non-matches -1. Prefix matches on
 * the full string rank highest, then matches at word boundaries, then earlier
 * substrings, then plain subsequences.
 */
export function fuzzyScore(query: string, target: string): number {
  const needle = query.toLowerCase();
  const haystack = target.toLowerCase();
  if (!needle) return 0;
  if (!fuzzyMatch(needle, haystack)) return -1;
  if (haystack.startsWith(needle)) return 100;
  const substringAt = haystack.indexOf(needle);
  if (substringAt !== -1) {
    let score = 50 + Math.max(0, 20 - substringAt);
    const boundaryBefore = substringAt === 0 || /[\s\-_/.]/.test(haystack[substringAt - 1] ?? '');
    if (boundaryBefore) score += 10;
    return score;
  }
  return 10;
}

function rankActions(actions: readonly PaletteAction[], query: string): PaletteAction[] {
  if (!query.trim()) return [...actions];
  return actions
    .map((action) => ({ action, score: fuzzyScore(query, `${action.title} ${action.hint ?? ''}`) }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.action);
}

/**
 * Filterable command palette. Type-to-filter with fuzzy matching ranked by
 * `fuzzyScore` (case-insensitive on title+hint), up/down to move, enter to
 * run, esc to close.
 */
export function CommandPalette({ actions, onClose }: { actions: readonly PaletteAction[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [running, setRunning] = useState(false);

  const filtered = useMemo(() => rankActions(actions, query), [actions, query]);

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
