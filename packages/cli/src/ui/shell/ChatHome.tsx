import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useInput } from 'ink';
import { currentPermissionMode } from '../../permissions-state.js';
import { parseSlashCommand } from '../turn.js';
import { useTurn } from '../useTurn.js';
import type { ChatMessage } from '../useTurn.js';
import type { TurnRunner } from '../turn.js';
import { ActivityIndicator } from './Activity.js';
import { Frame } from './Frame.js';

export interface SlashCommand {
  name: string;
  description: string;
  usage?: string;
}

export interface ChatHomeProps {
  runner: TurnRunner;
  commands: readonly SlashCommand[];
  onSlashCommand?: (name: string, args: string[]) => void;
  provider?: string;
  model?: string;
  /** Contextual label shown next to the spinner while a turn is running. */
  activity?: string;
  projectName?: string;
}

/** Built-in slash-command registry surfaced in the suggestion menu. */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'help', description: 'Show help and keyboard shortcuts' },
  { name: 'connect', description: 'Connect to a provider endpoint' },
  { name: 'providers', description: 'List configured providers' },
  { name: 'models', description: 'List available models for the active provider' },
  { name: 'model', description: 'Select the active model', usage: '/model <name>' },
  { name: 'tools', description: 'List available tools' },
  { name: 'skills', description: 'List or toggle agent skills', usage: '/skills [name]' },
  { name: 'agents', description: 'List registered agents' },
  { name: 'workflows', description: 'List available workflows' },
  { name: 'runs', description: 'Inspect recent runs' },
  { name: 'inspect', description: 'Inspect a run, tool, or object', usage: '/inspect <id>' },
  { name: 'test', description: 'Run project tests', usage: '/test [pattern]' },
  { name: 'doctor', description: 'Diagnose environment and configuration' },
  { name: 'config', description: 'View or edit configuration' },
  { name: 'settings', description: 'Open settings screen' },
  { name: 'clear', description: 'Clear the conversation' },
  { name: 'status', description: 'Show session status summary' },
  { name: 'init', description: 'Initialize an .agentforge project' },
  { name: 'new', description: 'Start a new project', usage: '/new <name>' },
  { name: 'project', description: 'Show or switch the active project', usage: '/project [name]' },
  { name: 'chat', description: 'Focus the chat conversation' },
  { name: 'exit', description: 'Exit AgentForge' },
];

const EXIT_CONFIRM_MS = 2000;

function MessageRow({ message }: { message: ChatMessage }) {
  if (message.role === 'user') return <Text><Text color="green">you › </Text>{message.text}</Text>;
  if (message.role === 'system') return <Text dimColor>note › {message.text}</Text>;
  if (message.role === 'tool') {
    const ms = message.meta?.ms;
    return (
      <Text dimColor>
        {'\\u2699'} tool › {message.meta?.tool ?? message.text}
        {ms !== undefined ? ` (${(ms / 1000).toFixed(1)}s)` : ''}
      </Text>
    );
  }
  return <Text><Text color="cyan">agent › </Text>{message.text}</Text>;
}

/**
 * Chat-first home screen: a persistent chat interface with live streaming,
 * inline slash-command suggestions above the input, and a status bar.
 */
export function ChatHome({ runner, commands, onSlashCommand, provider = 'mock', model, activity, projectName }: ChatHomeProps) {
  const { messages, streamingText, running, status, lastError, send, cancel, clear, pushSystem } = useTurn(runner);
  const [input, setInput] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const draftRef = useRef('');
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Welcome banner so users know the interface is ready and how to discover
  // commands (rendered once, before the first message).
  useEffect(() => {
    pushSystem('AgentForge ready — type a message to chat, or / for commands. /help lists everything.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => {
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
  }, []);

  const menuOpen = input.startsWith('/') && !menuDismissed;
  const filtered = useMemo(() => {
    if (!menuOpen) return [];
    const needle = input.slice(1).split(/\s+/)[0]?.toLowerCase() ?? '';
    return commands.filter((command) => command.name.toLowerCase().startsWith(needle));
  }, [commands, input, menuOpen]);

  const clampedIndex = Math.min(selectedIndex, Math.max(filtered.length - 1, 0));
  const selected = filtered[clampedIndex];
  /** Commands with a usage signature run immediately on select only when no args are declared. */
  const takesArgs = Boolean(selected?.usage && selected.usage.trim().split(/\s+/).length > 1);

  const selectSuggestion = () => {
    if (!selected) return;
    setSelectedIndex(0);
    setMenuDismissed(false);
    if (!takesArgs) {
      setInput('');
      if (selected.name === 'clear') clear();
      else onSlashCommand?.(selected.name, []);
    } else {
      setInput(`/${selected.name} `);
    }
  };

  const submit = () => {
    const raw = input.trim();
    setInput('');
    setSelectedIndex(0);
    if (!raw) return;
    setHistory((previous) => (previous[previous.length - 1] === raw ? previous : [...previous, raw]));
    setHistoryIndex(-1);
    draftRef.current = '';
    if (!raw.startsWith('/')) {
      void send(raw);
      return;
    }
    const command = parseSlashCommand(raw);
    if (!command) {
      pushSystem(`Unknown command: ${raw}`);
      return;
    }
    if (command.name === 'clear') {
      clear();
      return;
    }
    onSlashCommand?.(command.name, command.args);
  };

  useInput((value, key) => {
    if (key.ctrl && value === 'c') {
      if (running) { cancel(); return; }
      if (showExitConfirm) { process.exit(0); }
      setShowExitConfirm(true);
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
      exitTimerRef.current = setTimeout(() => setShowExitConfirm(false), EXIT_CONFIRM_MS);
      return;
    }

    // Input history recall — up/down cycle submitted inputs; only while the
    // suggestion menu is closed.
    if (!menuOpen && history.length > 0 && (key.upArrow || key.downArrow)) {
      if (key.upArrow) {
        if (historyIndex === -1) draftRef.current = input;
        const next = historyIndex === -1 ? history.length - 1 : Math.max(historyIndex - 1, 0);
        setHistoryIndex(next);
        setInput(history[next] ?? '');
      } else {
        const next = historyIndex + 1;
        if (next >= history.length) {
          setHistoryIndex(-1);
          setInput(draftRef.current);
        } else {
          setHistoryIndex(next);
          setInput(history[next] ?? '');
        }
      }
      return;
    }

    // Slash-menu navigation takes priority while open.
    if (menuOpen && filtered.length > 0) {
      if (key.upArrow) { setSelectedIndex(Math.max(clampedIndex - 1, 0)); return; }
      if (key.downArrow) { setSelectedIndex(Math.min(clampedIndex + 1, filtered.length - 1)); return; }
    }

    if (key.return) {
      if (menuOpen && filtered.length > 0 && !input.includes(' ')) {
        // Enter over the menu selects: no-arg commands run immediately,
        // arg-taking commands fill the input for further typing.
        selectSuggestion();
      } else {
        submit();
      }
      return;
    }

    if (key.escape) {
      if (menuOpen) { setMenuDismissed(true); setSelectedIndex(0); return; }
      setSelectedIndex(0);
      return;
    }

    if (key.ctrl && value === 'l') { clear(); setSelectedIndex(0); return; }
    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      setSelectedIndex(0);
      return;
    }
    if (key.upArrow || key.downArrow || key.tab) return;
    if (value && !key.ctrl && !key.meta) {
      setInput((current) => current + value);
      setMenuDismissed(false);
      if (historyIndex !== -1) { setHistoryIndex(-1); draftRef.current = ''; }
    }
  });

  return (
    <Frame
      mode={projectName ? { kind: 'project', name: projectName } : { kind: 'global' }}
      provider={provider}
      model={model}
    >
    <Box flexDirection="column">
      <Static items={messages}>
        {(message, index) => <MessageRow key={index} message={message} />}
      </Static>
      {streamingText ? <MessageRow message={{ role: 'assistant', text: streamingText }} /> : null}
      {running ? <ActivityIndicator label={activity ?? 'working… (Ctrl-C to cancel)'} /> : null}
      {lastError && !running ? (
        <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column" marginTop={1}>
          <Text color="red">{lastError}</Text>
          <Text dimColor>try /doctor or /help</Text>
        </Box>
      ) : null}
      {showExitConfirm ? <Text color="yellow">Press Ctrl+C again to exit</Text> : null}
      {menuOpen ? (
        <Box flexDirection="column">
          {filtered.length === 0
            ? <Text dimColor>(no matching commands)</Text>
            : filtered.map((command, position) => (
              <Text key={command.name} color={position === clampedIndex ? 'cyan' : undefined}>
                {position === clampedIndex ? '\u203a ' : '  '}/{command.name}
                {command.usage ? <Text dimColor> {command.usage}</Text> : null}
                {' — '}
                <Text dimColor>{command.description}</Text>
              </Text>
            ))}
        </Box>
      ) : null}
      <Box borderStyle="round" paddingX={1}>
        <Text color="green">❯ </Text>
        <Text>{input}</Text>
        <Text dimColor>▏</Text>
      </Box>
      <Box marginTop={0} gap={2}>
        <Text dimColor>{provider}{model ? ` · ${model}` : ''}</Text>
        <Text dimColor>mode: {currentPermissionMode()}</Text>
        {status.totalTokens !== undefined ? <Text dimColor>tokens: {status.totalTokens}</Text> : null}
        {status.elapsedMs !== undefined ? <Text dimColor>last: {(status.elapsedMs / 1000).toFixed(1)}s</Text> : null}
        <Text dimColor>[Ctrl+K] palette [?] help</Text>
      </Box>
    </Box>
    </Frame>
  );
}
