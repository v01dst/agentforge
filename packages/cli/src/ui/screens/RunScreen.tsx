import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { loadConfig } from '../../config.js';
import { importEntry } from '../../commands.js';
import { buildTurnRunner } from '../turn.js';
import type { TurnDelta } from '../turn.js';
import type { AgentForgeConfig, NamedEntry } from '../../types.js';

export interface ScreenProps {
  onDone?: () => void;
  onBack?: () => void;
}

type Step = 'entry' | 'input' | 'running' | 'complete' | 'error';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const DEFAULT_GREETING = 'Hello from AgentForge';

function namedEntries(items: readonly (string | { name?: string })[] | undefined): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (typeof item === 'string') return item;
      return item && typeof item.name === 'string' ? item.name : undefined;
    })
    .filter((value): value is string => Boolean(value));
}

function ActivityIndicator({ label }: { label: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((value) => (value + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, []);
  return (
    <Box gap={1}>
      <Text color="cyan">{SPINNER_FRAMES[frame]}</Text>
      <Text dimColor>{label} (Esc/Ctrl+C to cancel)</Text>
    </Box>
  );
}

export function RunScreen({ onDone, onBack }: ScreenProps) {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>('entry');
  const [entries, setEntries] = useState<readonly string[]>([]);
  const [configPath, setConfigPath] = useState<string>();
  const [selected, setSelected] = useState(0);
  const [customMode, setCustomMode] = useState(false);
  const [customPath, setCustomPath] = useState('');
  const [inputText, setInputText] = useState('');
  const [outputText, setOutputText] = useState('');
  const [running, setRunning] = useState(false);
  const [receivedFirstDelta, setReceivedFirstDelta] = useState(false);
  const [totalTokens, setTotalTokens] = useState<number>();
  const [runId, setRunId] = useState<string>();
  const [durationMs, setDurationMs] = useState<number>();
  const [error, setError] = useState('');
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { path, config } = await loadConfig({ required: false });
        if (cancelled) return;
        const list: string[] = [];
        const extended = config as AgentForgeConfig & { agents?: readonly (string | NamedEntry)[] };
        const entry = extended.entry;
        if (typeof entry === 'string' && entry) list.push(entry);
        for (const name of namedEntries(extended.agents)) if (!list.includes(name)) list.push(name);
        for (const name of namedEntries((config as AgentForgeConfig).workflows)) if (!list.includes(name)) list.push(name);
        setEntries(list);
        setConfigPath(path);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (step !== 'running') return;
    let cancelled = false;
    const chosenEntry = customMode ? customPath.trim() : entries[selected] ?? '';
    const controller = new AbortController();
    controllerRef.current = controller;
    void (async () => {
      setOutputText('');
      setReceivedFirstDelta(false);
      setTotalTokens(undefined);
      setRunId(undefined);
      setRunning(true);
      const startedAt = Date.now();
      try {
        const module = await importEntry(chosenEntry, { configPath });
        const runner = buildTurnRunner(module);
        let text = '';
        const consume = async function* (): AsyncGenerator<TurnDelta> {
          yield* runner(inputText.trim() || DEFAULT_GREETING, controller.signal, { skills: [] });
        };
        for await (const delta of consume()) {
          if (cancelled) break;
          if (delta.text) {
            text += delta.text;
            setReceivedFirstDelta(true);
            setOutputText(text);
          }
          if (delta.usage?.totalTokens !== undefined) setTotalTokens(delta.usage.totalTokens);
          if (delta.runId) setRunId(delta.runId);
        }
        if (cancelled) return;
        setDurationMs(Date.now() - startedAt);
        setStep('complete');
      } catch (cause) {
        if (controller.signal.aborted || cancelled) {
          if (!cancelled) setStep('complete');
          return;
        }
        setError(cause instanceof Error ? cause.message : String(cause));
        setStep('error');
      } finally {
        setRunning(false);
        controllerRef.current = null;
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const finish = useCallback(() => {
    if (onDone) onDone();
    else exit();
  }, [onDone, exit]);

  useInput((value, key) => {
    if (key.ctrl && value === 'c') {
      if (step === 'running' && controllerRef.current) {
        controllerRef.current.abort();
        return;
      }
      exit();
      return;
    }
    if (key.escape) {
      if (step === 'running' && controllerRef.current) {
        controllerRef.current.abort();
        return;
      }
      if (step === 'entry') onBack?.();
      else if (step === 'input') setStep('entry');
      else finish();
      return;
    }
    if (step === 'entry' && !customMode) {
      if (!entries.length && key.return) {
        setCustomMode(true);
        return;
      }
      if (key.upArrow) setSelected((current) => Math.max(0, current - 1));
      else if (key.downArrow) setSelected((current) => Math.min(entries.length - 1, current + 1));
      else if (key.tab) setCustomMode(true);
      else if (key.return && entries[selected]) setStep('input');
      return;
    }
    if (customMode && step === 'entry') {
      if (key.return && customPath.trim()) setStep('input');
      else if (key.backspace || key.delete) setCustomPath((current) => current.slice(0, -1));
      else if (value) setCustomPath((current) => current + value);
      return;
    }
    if (step === 'input') {
      if (key.return) setStep('running');
      else if (key.backspace || key.delete) setInputText((current) => current.slice(0, -1));
      else if (value) setInputText((current) => current + value);
      return;
    }
    if (step === 'error' || step === 'complete') {
      if (value === 'r' || value === 'R') setStep('running');
      else if (key.return) finish();
    }
  });

  const spinnerLabel = receivedFirstDelta ? 'Generating response...' : 'Initializing agent...';

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="magenta">AgentForge · run</Text>
      </Box>

      {step === 'entry' ? (
        <Box flexDirection="column">
          <Text bold>Select entrypoint:</Text>
          {entries.map((candidate, index) => (
            <Text key={candidate} color={index === selected ? 'cyan' : undefined}>
              {index === selected ? '❯ ' : '  '}{candidate}
            </Text>
          ))}
          {!entries.length ? <Text dimColor>(no entrypoints found — Tab to type a path)</Text> : null}
          {customMode ? (
            <Box borderStyle="round" paddingX={1}>
              <Text color="cyan">path ❯ </Text>
              <Text>{customPath}</Text>
              <Text dimColor>▏</Text>
            </Box>
          ) : null}
          <Text dimColor>↑/↓ select · Enter continue · Tab type path · Esc back</Text>
        </Box>
      ) : null}

      {step === 'input' ? (
        <Box flexDirection="column">
          <Text bold>Input (optional, Enter uses default greeting):</Text>
          <Box borderStyle="round" paddingX={1}>
            <Text color="green">❯ </Text>
            <Text>{inputText}</Text>
            <Text dimColor>▏</Text>
          </Box>
          {!inputText ? <Text dimColor>default: “{DEFAULT_GREETING}”</Text> : null}
        </Box>
      ) : null}

      {(step === 'running' || step === 'complete') ? (
        <Box flexDirection="column">
          {outputText ? (
            <Box borderStyle="round" borderColor="cyan" paddingX={1}>
              <Text>{outputText}</Text>
            </Box>
          ) : null}
          {running ? <ActivityIndicator label={spinnerLabel} /> : null}
          {!running ? (
            <Box marginTop={1} gap={2}>
              {durationMs !== undefined ? <Text dimColor>duration: {(durationMs / 1000).toFixed(1)}s</Text> : null}
              {totalTokens !== undefined ? <Text dimColor>tokens: {totalTokens}</Text> : null}
              {runId ? <Text dimColor>runId: {runId}</Text> : null}
              <Text dimColor>[R] run again · [Enter] back</Text>
            </Box>
          ) : null}
        </Box>
      ) : null}

      {step === 'error' ? (
        <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red">✖ Run failed: {error}</Text>
          <Text dimColor>Check agentforge.config.ts or run agentforge doctor.</Text>
          <Text dimColor>[R] run again · [Enter] back</Text>
        </Box>
      ) : null}
    </Box>
  );
}
