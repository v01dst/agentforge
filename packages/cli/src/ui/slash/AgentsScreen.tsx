import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { loadConfig } from '../../config.js';
import type { NamedEntry } from '../../types.js';
import { listAgentsSync } from '../../agents/agents.js';

interface AgentRow {
  name: string;
  description: string;
  kind: 'entry' | 'agent' | 'md';
  detail?: string;
}

function toRows(entry: string | undefined, agents: readonly (string | NamedEntry)[] | undefined): AgentRow[] {
  const rows: AgentRow[] = [];
  if (entry) rows.push({ name: entry, description: 'project entry', kind: 'entry' });
  for (const agent of agents ?? []) {
    if (typeof agent === 'string') rows.push({ name: agent, description: '(no description)', kind: 'agent' });
    else rows.push({ name: agent.name, description: agent.description ?? '(no description)', kind: 'agent' });
  }
  // Markdown agent definitions (Phase F): mode + posture as detail.
  for (const md of listAgentsSync(process.cwd())) {
    const detail = `${md.mode}${md.permission ? ` · ${md.permission}` : ''}${md.source !== 'builtin' ? ` · ${md.source}` : ''}`;
    rows.push({ name: md.name, description: md.description ?? '(no description)', kind: 'md', detail });
  }
  return rows;
}

export function AgentsScreen({
  onBack,
  openScreen,
  pushSystem,
}: {
  onBack?: () => void;
  openScreen: (screen: 'run') => void;
  pushSystem: (text: string) => void;
}): React.ReactElement {
  const [rows, setRows] = useState<AgentRow[] | null>(null);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    let alive = true;
    void loadConfig({ required: false })
      .then((loaded) => {
        if (!alive) return;
        const config = loaded.config as { entry?: string; agents?: readonly (string | NamedEntry)[] };
        setRows(toRows(config.entry, config.agents));
      })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, []);

  const current = rows === null ? undefined : rows.length ? rows[Math.min(selected, rows.length - 1)] : undefined;

  useInput((input, key) => {
    if (key.escape) { onBack?.(); return; }
    if (!rows?.length) return;
    if (key.upArrow) { setSelected((s) => Math.max(0, s - 1)); return; }
    if (key.downArrow) { setSelected((s) => Math.min(rows.length - 1, s + 1)); return; }
    if (key.return && current) {
      if (current.kind === 'md') {
        pushSystem(`${current.name} — ${current.detail}: ${current.description}`);
        return;
      }
      process.env.AGENTFORGE_ENTRY = current.name;
      pushSystem(`Active entry: ${current.name} (${current.description})`);
      openScreen('run');
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Agents</Text>
      <Text dimColor>↑/↓ select · enter switch entry & run · Esc back</Text>
      <Box flexDirection="column" marginTop={1}>
        {rows === null
          ? <Text dimColor>Loading agents…</Text>
          : rows.length === 0
            ? <Text dimColor>(no agents configured — set config.entry or config.agents)</Text>
            : rows.map((row, index) => (
                <Text key={`${row.kind}:${row.name}`} color={index === selected ? 'cyan' : undefined}>
                  {index === selected ? '❯ ' : '  '}
                  {row.name}
                  <Text dimColor> — {row.kind === 'entry' ? `entry · ${row.description}` : row.kind === 'md' ? `${row.detail} · ${row.description}` : row.description}</Text>
                </Text>
              ))}
      </Box>
      {current ? (
        <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
          <Text bold>{current.name}</Text>
          <Text dimColor>{current.description}</Text>
          <Text>{current.kind === 'md' ? 'markdown agent definition' : 'enter — switch to this entry and open the runner'}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
