import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../../config.js';
import { buildModelReport } from '../../session.js';
import { listSkills } from '../../skills/skills.js';
import { ActivityIndicator } from './Activity.js';
import { badge, badgeColor, colors, sectionHeader } from './theme.js';

/** Navigation callbacks invoked by the quick-actions menu (wired by the parent shell). */
export interface DashboardActions {
  onChat: () => void;
  onRun: () => void;
  onNewProject: () => void;
  onTools: () => void;
  onWorkflows: () => void;
  onModels: () => void;
  onTest: () => void;
  onDoctor: () => void;
  onSettings: () => void;
  onPalette: () => void;
}

export interface DashboardProps extends DashboardActions {
  /** When false the menu ignores keyboard input (e.g. palette overlay is open). */
  active?: boolean;
}

interface SectionState<T> { data: T | null }

function useAsyncSection<T>(load: () => Promise<T>, deps: readonly unknown[] = []): SectionState<T> {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let cancelled = false;
    load().then((value) => { if (!cancelled) setData(value); }).catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data };
}

async function loadProject() {
  const { path, config } = await loadConfig({ required: false });
  return { found: Boolean(path), path, name: config.name, entry: config.entry };
}

async function loadModels() {
  const { config } = await loadConfig({ required: false });
  const rows = buildModelReport(config.providers ?? []);
  return { ready: rows.filter((row) => row.ready === true).length, total: rows.length };
}

async function loadCounts() {
  const { config } = await loadConfig({ required: false });
  const skills = await listSkills();
  return { tools: (config.tools ?? []).length, workflows: (config.workflows ?? []).length, skills: skills.length };
}

async function loadRuns(): Promise<string[]> {
  const dir = join(process.cwd(), '.agentforge', 'runs');
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const stamped = await Promise.all(names.map(async (name) => {
    try { return { name, mtime: (await stat(join(dir, name))).mtimeMs }; } catch { return { name, mtime: 0 }; }
  }));
  return stamped.sort((a, b) => b.mtime - a.mtime).slice(0, 5).map((entry) => entry.name);
}

const QUICK_ACTIONS: ReadonlyArray<{ label: string; key: keyof DashboardActions }> = [
  { label: 'Chat with agent', key: 'onChat' },
  { label: 'Run agent once', key: 'onRun' },
  { label: 'New project', key: 'onNewProject' },
  { label: 'Tools', key: 'onTools' },
  { label: 'Workflows', key: 'onWorkflows' },
  { label: 'Models & providers', key: 'onModels' },
  { label: 'Run tests', key: 'onTest' },
  { label: 'Doctor diagnostics', key: 'onDoctor' },
  { label: 'Settings', key: 'onSettings' },
  { label: 'Command palette (Ctrl+K)', key: 'onPalette' },
];

/** Dashboard home screen — presentational; all navigation happens via props. */
export function Dashboard(props: DashboardProps) {
  const { active = true } = props;
  const project = useAsyncSection(loadProject);
  const models = useAsyncSection(loadModels);
  const counts = useAsyncSection(loadCounts);
  const runs = useAsyncSection(loadRuns);
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    if (!active) return;
    if (key.upArrow) setSelected(Math.max(selected - 1, 0));
    else if (key.downArrow) setSelected(Math.min(selected + 1, QUICK_ACTIONS.length - 1));
    else if (key.return) {
      const action = QUICK_ACTIONS[selected];
      if (action) props[action.key]();
    }
  });

  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      <Text bold color={colors.accent}>{sectionHeader('AgentForge')}</Text>

      <Box flexDirection="column">
        <Text>{sectionHeader('Project')}</Text>
        {project.data === null
          ? <ActivityIndicator label="Loading project" />
          : project.data.found ? (
            <>
              <Text><Text color={colors.success}>{badge('ready')}</Text> config: {project.data.name ?? '(unnamed)'}</Text>
              <Text dimColor>entry: {project.data.entry ?? '(not set)'}</Text>
            </>
          ) : (
            <Text color={colors.warn}>{badge('missing')} no agentforge.config.ts found — run `agentforge init`</Text>
          )}
      </Box>

      <Box flexDirection="column">
        <Text>{sectionHeader('Models & providers')}</Text>
        {models.data === null
          ? <ActivityIndicator label="Loading models" />
          : <Text><Text color={models.data.ready > 0 ? colors.success : colors.warn}>{badge(models.data.ready > 0 ? 'ready' : 'missing')}</Text> {models.data.ready}/{models.data.total} providers ready</Text>}
      </Box>

      <Box flexDirection="column">
        <Text>{sectionHeader('Workspace')}</Text>
        {counts.data === null
          ? <ActivityIndicator label="Loading workspace" />
          : <Text dimColor>tools: {counts.data.tools} · workflows: {counts.data.workflows} · skills: {counts.data.skills}</Text>}
      </Box>

      <Box flexDirection="column">
        <Text>{sectionHeader('Recent runs')}</Text>
        {runs.data === null
          ? <ActivityIndicator label="Loading runs" />
          : runs.data.length === 0
            ? <Text dimColor>(no runs yet)</Text>
            : runs.data.map((name) => <Text key={name} dimColor>- {name}</Text>)}
      </Box>

      <Box flexDirection="column">
        <Text>{sectionHeader('Quick actions')}</Text>
        {QUICK_ACTIONS.map((action, index) => (
          <Text key={action.key} color={index === selected ? colors.accent : undefined}>
            {index === selected ? '\u203a ' : '  '}{action.label}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
