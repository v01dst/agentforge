import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useInput } from 'ink';
import { parseSlashCommand } from '../turn.js';
import { useTurn } from '../useTurn.js';
import type { ChatMessage } from '../useTurn.js';
import type { TurnRunner } from '../turn.js';
import { ActivityIndicator } from './Activity.js';
import { colors } from './theme.js';
import { listSessions, loadSession, newSessionId, saveSession } from '../../sessions/store.js';
import { validateProviderConnection } from '../../global-config.js';
import type { GlobalProviderEntry } from '../../global-config.js';

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
  /** True when no provider key is configured — show inline first-run onboarding. */
  needsOnboarding?: boolean;
  /** Seed the composer with text on mount (used by headless tests). */
  initialInput?: string;
  /** Restore the most recent stored conversation on mount (default true). */
  autoResume?: boolean;
  /** Seed messages (e.g. `agentforge sessions resume <id>`). Skips auto-resume. */
  initialMessages?: ChatMessage[];
  /** Called after a provider key validates so the parent can refresh status. */
  onProviderConnected?: () => void;
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
  if (message.role === 'user') return <Text><Text color={colors.uiOk}>you › </Text>{message.text}</Text>;
  if (message.role === 'system') return <Text dimColor>note › {message.text}</Text>;
  if (message.role === 'tool') {
    const ms = message.meta?.ms;
    return (
      <Text color={colors.tool}>
        {'⚙ tool › '}{message.meta?.tool ?? message.text}
        {ms !== undefined ? ` (${(ms / 1000).toFixed(1)}s)` : ''}
      </Text>
    );
  }
  return <Text><Text color={colors.accent}>agent › </Text>{message.text}</Text>;
}

/**
 * Chat-first home screen: a persistent chat interface with live streaming,
 * inline slash-command suggestions above the input, and a status bar.
 */
export function ChatHome({ runner, commands, onSlashCommand, provider = 'mock', model, activity, projectName, needsOnboarding = false, onProviderConnected, initialInput, autoResume = true, initialMessages }: ChatHomeProps) {
  const { messages, streamingText, running, status, lastError, toolEvents, send, cancel, clear, pushSystem, hydrate } = useTurn(runner);
  const sessionIdRef = useRef(newSessionId());
  const restoredRef = useRef(false);
  const [input, setInput] = useState(initialInput ?? '');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [awaitingChoice, setAwaitingChoice] = useState<'provider' | 'key' | undefined>(undefined);
  const [pendingProvider, setPendingProvider] = useState<Pick<GlobalProviderEntry, 'name' | 'protocol' | 'apiKeyEnv'> | null>(null);
  const draftRef = useRef('');
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Session restore: explicit seed wins, then latest stored conversation.
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (initialMessages?.length) {
      hydrate(initialMessages);
      pushSystem(`resumed ${initialMessages.length} message(s) from CLI`);
      return;
    }
    if (!autoResume) return;
    void (async () => {
      const [latest] = await listSessions();
      if (!latest || latest.messages === 0) return;
      const stored = await loadSession(latest.id);
      if (!stored?.messages.length) return;
      sessionIdRef.current = stored.id;
      hydrate(stored.messages);
      pushSystem(`resumed session ${stored.id} — ${stored.messages.length} message(s). /new starts fresh.`);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autosave whenever the transcript changes while idle.
  useEffect(() => {
    if (running || messages.length === 0) return;
    void saveSession({
      id: sessionIdRef.current,
      title: messages.find((entry) => entry.role === 'user')?.text.slice(0, 48) ?? 'session',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages,
      provider,
      model,
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, running]);

  // Welcome banner so users know the interface is ready and how to discover
  // commands (rendered once, before the first message). During first-run
  // onboarding it instead presents the provider picker.
  useEffect(() => {
    if (needsOnboarding) {
      pushSystem(
        'Welcome to AgentForge.\n\nNo model connected yet. Pick one:\n' +
        '  [1] OpenAI     (OPENAI_API_KEY)\n' +
        '  [2] Anthropic  (ANTHROPIC_API_KEY)\n' +
        '  [3] Google     (GEMINI_API_KEY)\n' +
        '  [s] Skip — use offline mock\n\n' +
        'Reply with a number, or set the env var and /reload.',
      );
      setAwaitingChoice('provider');
      return;
    }
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
      if (handleOnboardingInput(raw)) return;
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
    if (command.name === 'new') {
      clear();
      sessionIdRef.current = newSessionId();
      pushSystem('new session started');
      return;
    }
    if (command.name === 'sessions') {
      void (async () => {
        const all = await listSessions();
        if (!all.length) { pushSystem('no stored sessions'); return; }
        pushSystem(['stored sessions:', ...all.slice(0, 8).map((entry) => `  ${entry.id}  ${entry.messages} msgs  ${entry.title}`)].join('\n'));
      })();
      return;
    }
    if (command.name === 'resume') {
      void (async () => {
        const id = command.args[0] ?? (await listSessions())[0]?.id;
        if (!id) { pushSystem('nothing to resume'); return; }
        const stored = await loadSession(id);
        if (!stored) { pushSystem(`unknown session: ${id}`); return; }
        sessionIdRef.current = stored.id;
        clear();
        hydrate(stored.messages);
        pushSystem(`resumed ${stored.id} (${stored.messages.length} msgs)`);
      })();
      return;
    }
    onSlashCommand?.(command.name, command.args);
  };

  /** Inline first-run provider onboarding: runs only for non-slash input. */
  const handleOnboardingInput = (raw: string): boolean => {
    if (awaitingChoice === 'provider') {
      if (raw === '1' || raw === '2' || raw === '3') {
        const options: ReadonlyArray<Pick<GlobalProviderEntry, 'name' | 'protocol' | 'apiKeyEnv'>> = [
          { name: 'OpenAI', protocol: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
          { name: 'Anthropic', protocol: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' },
          { name: 'Google', protocol: 'gemini', apiKeyEnv: 'GEMINI_API_KEY' },
        ];
        const chosen = options[Number(raw) - 1];
        if (!chosen) return true;
        setPendingProvider(chosen);
        setAwaitingChoice('key');
        pushSystem(`Paste your ${chosen.apiKeyEnv} (input will be masked):`);
      } else if (raw === 's' || raw === 'S') {
        setAwaitingChoice(undefined);
        pushSystem('Offline mock mode active — /connect anytime.');
      } else {
        pushSystem('Reply with 1, 2, 3, or s to skip.');
      }
      return true;
    }
    if (awaitingChoice === 'key') {
      const entry = pendingProvider;
      setAwaitingChoice(undefined);
      setPendingProvider(null);
      if (!entry) return true;
      process.env[entry.apiKeyEnv] = raw;
      void validateProviderConnection(entry, { live: false }).then((result) => {
        if (result.ok) {
          pushSystem('connected — say hello!');
          onProviderConnected?.();
        } else {
          pushSystem(result.reason ?? `Could not validate ${entry.name}.`);
        }
      });
      return true;
    }
    return false;
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
    <Box flexDirection="column">
      <Static items={messages}>
        {(message, index) => <MessageRow key={index} message={message} />}
      </Static>
      {streamingText ? <MessageRow message={{ role: 'assistant', text: streamingText }} /> : null}
      <Box flexDirection="column">
        {toolEvents.map((event) =>
          event.state === 'running' ? (
            <Text key={`${event.name}-running`} color={colors.tool}>
              {'⠿ '}{event.name}{event.argsSummary ? ` ${event.argsSummary.slice(0, 60)}` : ''}
            </Text>
          ) : (
            <Text key={`${event.name}-done`} color={colors.uiOk}>
              {'✓ '}{event.name}{event.ms !== undefined ? ` (${event.ms}ms)` : ''}
            </Text>
          ),
        )}
      </Box>
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
      <Box borderStyle="round" borderColor={colors.border} paddingX={1}>
        <Text color={colors.accent}>❯ </Text>
        <Text>{input}</Text>
        <Text dimColor>▏</Text>
      </Box>
      <StatusLine
        provider={provider}
        model={model}
        projectName={projectName}
        totalTokens={status.totalTokens}
        elapsedMs={status.elapsedMs}
      />
    </Box>
  );
}

/**
 * Single dim status line replacing the old header/footer chrome:
 * `project:<name> · <provider>/<model> · <N> tok · <X.X>s · ctrl+c cancel`.
 * Segments are omitted when their value is undefined.
 */
function StatusLine({
  provider,
  model,
  projectName,
  totalTokens,
  elapsedMs,
}: {
  provider?: string;
  model?: string;
  projectName?: string;
  totalTokens?: number;
  elapsedMs?: number;
}) {
  const segments: string[] = [];
  if (projectName) segments.push(`project:${projectName}`);
  if (provider || model) segments.push([provider, model].filter(Boolean).join('/'));
  if (totalTokens !== undefined) segments.push(`${totalTokens} tok`);
  if (elapsedMs !== undefined) segments.push(`${(elapsedMs / 1000).toFixed(1)}s`);
  segments.push('ctrl+c cancel');
  return (
    <Box marginTop={0}>
      {segments.length > 0 ? <Text dimColor>{segments.join(' · ')}</Text> : null}
    </Box>
  );
}
