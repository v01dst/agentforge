import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { loadConfig } from '../../config.js';
import { runCommand } from '../../commands.js';

interface WorkflowRow {
  name: string;
  description?: string;
}

function toRows(workflows: readonly (string | WorkflowRow)[] | undefined): WorkflowRow[] {
  return (workflows ?? []).map((entry) => (typeof entry === 'string' ? { name: entry } : entry));
}

export function WorkflowsScreen({
  onBack,
  runSuspended,
}: {
  onBack?: () => void;
  runSuspended: (fn: () => Promise<number>) => Promise<void>;
}): React.ReactElement {
  const [rows, setRows] = useState<WorkflowRow[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [status, setStatus] = useState('');
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadConfig({ required: false })
      .then((loaded) => { if (alive) setRows(toRows(loaded.config.workflows)); })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, []);

  const current: WorkflowRow | undefined = rows === null
    ? undefined
    : rows.length
      ? rows[Math.min(selected, rows.length - 1)]
      : undefined;

  const runOnce = async (name: string): Promise<void> => {
    setRunning(true);
    try {
      await runSuspended(() => runCommand(name, {}));
    } finally {
      setRunning(false);
    }
  };

  useInput((input, key) => {
    if (key.escape) { onBack?.(); return; }
    if (!rows?.length) return;
    if (key.upArrow) { setSelected((s) => Math.max(0, s - 1)); return; }
    if (key.downArrow) { setSelected((s) => Math.min(rows.length - 1, s + 1)); return; }
    if ((key.return || input === 'r') && current && !running) {
      setStatus(`Running workflow ${current.name}…`);
      void runOnce(current.name);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Workflows</Text>
      <Text dimColor>↑/↓ select · enter run once · Esc back</Text>
      <Box flexDirection="column" marginTop={1}>
        {rows === null
          ? <Text dimColor>Loading workflows…</Text>
          : rows.length === 0
            ? <Text dimColor>(no workflows configured — define them in agentforge.config.ts)</Text>
            : rows.map((row, index) => (
                <Text key={row.name} color={index === selected ? 'cyan' : undefined}>
                  {index === selected ? '❯ ' : '  '}
                  {row.name}
                  {row.description ? <Text dimColor> — {row.description}</Text> : null}
                </Text>
              ))}
      </Box>
      {current ? (
        <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
          <Text bold>{current.name}</Text>
          <Text dimColor>{current.description ?? '(no description)'}</Text>
          <Text color={running ? 'yellow' : undefined}>enter — Run once</Text>
          {status ? <Text>{status}</Text> : null}
        </Box>
      ) : null}
    </Box>
  );
}
