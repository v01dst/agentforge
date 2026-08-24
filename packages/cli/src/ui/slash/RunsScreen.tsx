import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

interface RunRow {
  name: string;
  size: number;
  mtimeMs: number;
}

async function loadRuns(): Promise<RunRow[]> {
  const dir = join(process.cwd(), '.agentforge', 'runs');
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const rows = await Promise.all(names.map(async (name) => {
    try {
      const info = await stat(join(dir, name));
      return { name, size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      return { name, size: 0, mtimeMs: 0 };
    }
  }));
  return rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function loadRunBody(name: string): Promise<string> {
  try {
    const raw = await readFile(join(process.cwd(), '.agentforge', 'runs', name), 'utf8');
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  } catch (error) {
    return `Failed to read run: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function formatDate(mtimeMs: number): string {
  if (!mtimeMs) return '(unknown date)';
  return new Date(mtimeMs).toISOString().replace('T', ' ').slice(0, 19);
}

export function RunsScreen({ onBack }: { onBack?: () => void }): React.ReactElement {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [body, setBody] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void loadRuns().then((loaded) => { if (alive) setRuns(loaded); });
    return () => { alive = false; };
  }, []);

  const current: RunRow | undefined = runs === null
    ? undefined
    : runs.length
      ? runs[Math.min(selected, runs.length - 1)]
      : undefined;

  useInput((input, key) => {
    if (key.escape) {
      if (body !== null) { setBody(null); return; }
      onBack?.();
      return;
    }
    if (!runs?.length) return;
    if (key.upArrow) { setSelected((s) => Math.max(0, s - 1)); setBody(null); return; }
    if (key.downArrow) { setSelected((s) => Math.min(runs.length - 1, s + 1)); setBody(null); return; }
    if (key.return && current) void loadRunBody(current.name).then(setBody);
  });

  const detailLines = body === null ? [] : body.split('\n').slice(0, 40);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Recent runs</Text>
      <Text dimColor>↑/↓ select · enter inspect JSON · Esc back</Text>
      <Box flexDirection="column" marginTop={1}>
        {runs === null
          ? <Text dimColor>Loading runs…</Text>
          : runs.length === 0
            ? <Text dimColor>(no runs yet — run your agent first)</Text>
            : runs.map((run, index) => (
                <Text key={run.name} color={index === selected ? 'cyan' : undefined}>
                  {index === selected ? '❯ ' : '  '}
                  {run.name}
                  {'  '}
                  <Text dimColor>{run.size} bytes · {formatDate(run.mtimeMs)}</Text>
                </Text>
              ))}
      </Box>
      {detailLines.length ? (
        <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
          <Text bold>{current?.name ?? 'run'} — detail (first 40 lines)</Text>
          {detailLines.map((line, index) => <Text key={index}>{line}</Text>)}
          {body !== null && body.split('\n').length > 40 ? <Text dimColor>… truncated (full inspector coming later)</Text> : null}
          <Text dimColor>Esc close detail</Text>
        </Box>
      ) : null}
    </Box>
  );
}
