import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { loadConfig } from '../../config.js';
import { createCodingTools, type PolicyTool } from '../../coding-tools.js';
import type { NamedEntry } from '../../types.js';

interface ToolRow {
  name: string;
  description: string;
  permissions: string[];
  timeoutMs?: number;
  source: 'config' | 'coding';
  testable: boolean;
}

function toRows(configTools: readonly (string | NamedEntry)[], codingTools: readonly PolicyTool[]): ToolRow[] {
  const rows: ToolRow[] = configTools.map((entry) =>
    typeof entry === 'string'
      ? { name: entry, description: '(project-configured tool)', permissions: [], source: 'config' as const, testable: false }
      : {
          name: entry.name,
          description: entry.description ?? '(project-configured tool)',
          permissions: [],
          source: 'config' as const,
          testable: false,
        },
  );
  for (const tool of codingTools) {
    let testable = false;
    try {
      tool.inputSchema.parse({});
      testable = true;
    } catch {
      testable = false;
    }
    rows.push({
      name: tool.name,
      description: tool.description,
      permissions: [...(tool.permissions ?? [])],
      timeoutMs: tool.timeoutMs,
      source: 'coding',
      testable,
    });
  }
  return rows;
}

export function ToolsScreen({ onBack }: { onBack?: () => void }): React.ReactElement {
  const [rows, setRows] = useState<ToolRow[] | null>(null);
  const [hasProjectConfig, setHasProjectConfig] = useState(true);
  const [selected, setSelected] = useState(0);
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      let configTools: readonly (string | NamedEntry)[] = [];
      let foundProjectConfig = true;
      try {
        const loaded = await loadConfig({ required: false });
        // config.tools may be undefined with no project — built-ins still render.
        configTools = loaded.config.tools ?? [];
        foundProjectConfig = Boolean(loaded.path);
      } catch {
        configTools = [];
        foundProjectConfig = false;
      }
      if (alive) setHasProjectConfig(foundProjectConfig);
      let coding: PolicyTool[] = [];
      try {
        coding = createCodingTools();
      } catch {
        coding = [];
      }
      if (alive) setRows(toRows(configTools, coding));
    })();
    return () => { alive = false; };
  }, []);

  const current = rows?.[selected];

  const runTest = useMemo(() => async (): Promise<void> => {
    if (!current || !current.testable || busy) return;
    const tool = createCodingTools().find((candidate) => candidate.name === current.name);
    if (!tool) return;
    setBusy(true);
    const stamp = new Date().toLocaleTimeString();
    try {
      const result = await tool.execute({}, { runId: `tools-screen-${Date.now()}`, signal: new AbortController().signal });
      setLines((prev) => [`[${stamp}] ${tool.name} → ok`, JSON.stringify(result).slice(0, 400), ...prev].slice(0, 12));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLines((prev) => [`[${stamp}] ${tool.name} → error`, message.slice(0, 400), ...prev].slice(0, 12));
    } finally {
      setBusy(false);
    }
  }, [current, busy]);

  useInput((input, key) => {
    if (key.escape) { onBack?.(); return; }
    if (!rows?.length) return;
    if (key.upArrow) { setSelected((s) => Math.max(0, s - 1)); return; }
    if (key.downArrow) { setSelected((s) => Math.min(rows.length - 1, s + 1)); return; }
    if (input === 't') { void runTest(); return; }
    if (key.return) setSelected((s) => s); // selection already shows the detail panel
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Tools</Text>
      {!hasProjectConfig && rows !== null ? (
        <Text dimColor>(no project config found — showing built-in coding tools only; run /new or /cd to load project tools)</Text>
      ) : null}
      <Text dimColor>↑/↓ select · enter detail · t test invocation · Esc back</Text>
      <Box flexDirection="column" marginTop={1}>
        {rows === null
          ? <Text dimColor>Loading tools…</Text>
          : rows.length === 0
            ? <Text dimColor>(no tools configured)</Text>
            : rows.map((row, index) => (
                <Text key={`${row.source}:${row.name}`} color={index === selected ? 'cyan' : undefined}>
                  {index === selected ? '❯ ' : '  '}
                  {row.name}
                  {row.testable ? ' *' : ''}
                  <Text dimColor> — {row.description.split('\n')[0]}</Text>
                </Text>
              ))}
      </Box>
      {current ? (
        <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
          <Text bold>{current.name}</Text>
          <Text>{current.description}</Text>
          <Text dimColor>permissions: {current.permissions.length ? current.permissions.join(', ') : '(none)'}</Text>
          <Text dimColor>timeoutMs: {current.timeoutMs ?? '(default)'}</Text>
          <Text dimColor>source: {current.source}{current.testable ? ' · safe to test with empty input (t)' : ''}</Text>
        </Box>
      ) : null}
      {lines.length ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Test invocations</Text>
          {busy ? <Text dimColor>running…</Text> : null}
          {lines.map((line, index) => <Text key={index}>{line}</Text>)}
        </Box>
      ) : null}
    </Box>
  );
}
