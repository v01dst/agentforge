import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { colors } from '../shell/theme.js';
import { commandCatalog, type CommandCatalogEntry } from './registry.js';

/**
 * /help (0.8, X): the explain-everything cheat-sheet. Every registered
 * slash command, grouped by category, with usage and description —
 * generated from the live registry so it can never drift from reality.
 */

const CATEGORY_LABELS: Readonly<Record<CommandCatalogEntry['category'], string>> = {
  session: 'Session basics',
  config: 'Configuration — models, providers, modes, postures, profiles',
  resources: 'Resources — agents, skills, plugins, MCP, workflows, memory',
  project: 'Project — sessions, runs, inspection',
  system: 'System — help, doctor, diagnostics',
};

export function HelpScreen({ onBack }: { onBack?: () => void }): React.ReactElement {
  const catalog = useMemo(() => commandCatalog(), []);
  useInput((_value, key) => {
    if (key.escape || key.return) onBack?.();
  });
  const grouped = useMemo(() => {
    const map = new Map<CommandCatalogEntry['category'], CommandCatalogEntry[]>();
    for (const entry of catalog) {
      const list = map.get(entry.category) ?? [];
      list.push(entry);
      map.set(entry.category, list);
    }
    return [...map.entries()].sort((left, right) => left[0].localeCompare(right[0]));
  }, [catalog]);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={colors.bannerTitle}>◆ Command cheat-sheet</Text>
      <Text dimColor>  every /command, grouped by what it does · esc to return</Text>
      {grouped.map(([category, entries]) => (
        <Box key={category} flexDirection="column" marginTop={1}>
          <Text bold color={colors.tool}>{CATEGORY_LABELS[category] ?? category}</Text>
          {entries.map((entry) => (
            <Text key={entry.name}>
              {'  '}<Text color={colors.accent}>/{entry.name}</Text>
              {entry.usage && entry.usage !== `/${entry.name}` ? <Text dimColor> {entry.usage.replace(`/${entry.name}`, '').trim()}</Text> : null}
              <Text dimColor> — {entry.description}</Text>
              {entry.aliases?.length ? <Text dimColor> (alias: /{entry.aliases.join(' /')})</Text> : null}
            </Text>
          ))}
        </Box>
      ))}
      <Box flexDirection="column" marginTop={1}>
        <Text bold color={colors.tool}>Everyday flow</Text>
        <Text dimColor>  first run → ez-start connects a provider · type a task · approve edits · /new for a fresh session</Text>
        <Text dimColor>  /plan explore read-only → /build implement → /skills stage knowledge → /fork a branch of history</Text>
      </Box>
      <Text dimColor>  esc return</Text>
    </Box>
  );
}
