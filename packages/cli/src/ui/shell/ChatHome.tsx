import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, useInput } from 'ink';
import { parseSlashCommand } from '../turn.js';
import { useTurn } from '../useTurn.js';
import type { ChatMessage } from '../useTurn.js';
import type { TurnRunner } from '../turn.js';
import { ActivityIndicator } from './Activity.js';
import { colors } from './theme.js';
import { fuzzyScore } from './palette.js';
import { currentSessionMode } from '../../modes/session-modes.js';
import { currentPermissionMode } from '../../permissions.js';
import { listSessions, loadSession, newSessionId, renameSession, saveSession, SESSION_SCHEMA_VERSION, compactTranscript } from '../../sessions/store.js';
import { appendSessionLog, forkSession, loadFullTranscript } from '../../sessions/log.js';
import { loadMemory } from '../../memory/store.js';
import { listAgentsSync, extractAgentMentions } from '../../agents/agents.js';
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
  { name: 'memory', description: 'Show persistent memory and user profile' },
  { name: 'providers', description: 'List configured providers' },
  { name: 'models', description: 'List available models for the active provider' },
  { name: 'model', description: 'Select the active model', usage: '/model <name>' },
  { name: 'mode', description: 'Show or set the session mode (chat | build | indie | automode)', usage: '/mode [name]' },
  { name: 'permissions', description: 'Show or set the permission posture', usage: '/permissions [posture]' },
  { name: 'tools', description: 'List available tools' },
  { name: 'skills', description: 'List or toggle agent skills', usage: '/skills [name]' },
  { name: 'fork', description: 'Fork this or another session into a new one', usage: '/fork [id]' },
  { name: 'transcript', description: 'Show the full uncompacted transcript from the durable log', usage: '/transcript [id]' },
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

/** Word-wrap a string to `width` columns (CJK-safe enough for terminal use). */
function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine.length <= width) { lines.push(rawLine); continue; }
    let current = '';
    for (const word of rawLine.split(' ')) {
      if (!current) { current = word; continue; }
      if (current.length + 1 + word.length <= width) current = `${current} ${word}`;
      else { lines.push(current); current = word; }
    }
    if (current) lines.push(current);
  }
  return lines;
}

/**
 * One conversational message rendered as a modern block (0.8 redesign):
 * a role chip + wrapped content, separated by whitespace — no more
 * `you ›` text prefixes. System notes stay compact one-liners.
 */
function MessageRow({ message }: { message: ChatMessage }): React.ReactElement {
  if (message.role === 'system') {
    return <Text dimColor>  · {message.text.replace(/\n/g, ' · ')}</Text>;
  }
  if (message.role === 'tool') {
    const ms = message.meta?.ms;
    return (
      <Text color={colors.tool}>
        {'  ├ '}{message.meta?.tool ?? message.text}
        {ms !== undefined ? `  ${ms}ms` : ''}
      </Text>
    );
  }
  if (message.role === 'user') {
    return (
      <Box flexDirection="column" marginTop={0}>
        <Text><Text bold color={colors.uiOk}>YOU</Text><Text dimColor> ──</Text></Text>
        {wrapText(message.text, 100).map((line, index) => <Text key={index}>  {line}</Text>)}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={0}>
      <Text><Text bold color={colors.accent}>AGENT</Text><Text dimColor> ──</Text></Text>
      {wrapText(message.text, 100).map((line, index) => <Text key={index}>  {line}</Text>)}
      <Text> </Text>
    </Box>
  );
}

/** Live agent output while the turn streams. */
function AgentBlock({ text, streaming }: { text: string; streaming?: boolean }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={0}>
      <Text><Text bold color={colors.accent}>AGENT</Text>{streaming ? <Text dimColor> ── thinking…</Text> : <Text dimColor> ──</Text>}</Text>
      {wrapText(text, 100).map((line, index) => <Text key={index}>  {line}</Text>)}
    </Box>
  );
}

/** Tool activity as a vertical timeline: `├ ✓ name 12ms`. */
function ToolTimeline({ events }: { events: ReadonlyArray<{ name: string; state: 'running' | 'done'; ms?: number; argsSummary?: string }> }): React.ReactElement {
  if (!events.length) return <></>;
  return (
    <Box flexDirection="column">
      {events.map((event) =>
        event.state === 'running' ? (
          <Text key={`${event.name}-running`} color={colors.tool}>
            {'  ├ ⠿ '}{event.name}{event.argsSummary ? ` ${event.argsSummary.slice(0, 48)}` : ''}
          </Text>
        ) : (
          <Text key={`${event.name}-done`} color={colors.uiOk}>
            {'  ├ ✓ '}{event.name}{event.ms !== undefined ? `  ${event.ms}ms` : ''}
          </Text>
        ),
      )}
    </Box>
  );
}

/** Inline error — tinted lines, no oversized border box. */
function InlineError({ message }: { message: string }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={0}>
      {wrapText(message, 98).map((line, index) => <Text key={index} color={colors.error}>  ✗ {index === 0 ? '' : '  '}{line}</Text>)}
      <Text dimColor>  try /doctor or /help</Text>
    </Box>
  );
}

/** Slash suggestion menu with fuzzy-ranked rows and detail hints. */
function SlashMenu({ filtered, clampedIndex, empty }: { filtered: readonly SlashCommand[]; clampedIndex: number; empty: boolean }): React.ReactElement {
  if (empty) return <Text dimColor>  (no matching commands)</Text>;
  return (
    <Box flexDirection="column">
      {filtered.slice(0, 9).map((command, position) => (
        <Text key={command.name} color={position === clampedIndex ? colors.accent : undefined}>
          {position === clampedIndex ? '  ❯ /' : '    /'}{command.name}
          {command.usage ? <Text dimColor> {command.usage}</Text> : null}
          <Text dimColor> — {command.description}</Text>
        </Text>
      ))}
    </Box>
  );
}

/** Footer key hints. */
function FooterHints(): React.ReactElement {
  return <Text dimColor>  enter send · / commands · ctrl+c cancel turn · ctrl+c twice exit</Text>;
}

/**
 * Chat-first home screen: a persistent chat interface with live streaming,
 * inline slash-command suggestions above the input, and a status bar.
 */
export function ChatHome({ runner, commands, onSlashCommand, provider = 'mock', model, activity, projectName, needsOnboarding = false, onProviderConnected, initialInput, autoResume = true, initialMessages }: ChatHomeProps) {
  const { messages, streamingText, running, status, lastError, toolEvents, send, cancel, clear, pushSystem, hydrate } = useTurn(runner);
  const sessionIdRef = useRef(newSessionId());
  const restoredRef = useRef(false);
  /** Custom title set via /rename; autosave preserves it instead of re-deriving. */
  const titleRef = useRef<string | null>(null);
  /** Rolling summary of turns removed by compaction; survives resumes. */
  const summaryRef = useRef<string | undefined>(undefined);
  /** Original creation timestamp; autosave must not rewrite history. */
  const createdAtRef = useRef<string | null>(null);
  /** Interrupt-and-redirect (Phase D): text queued while a turn was running. */
  const redirectRef = useRef<string | null>(null);
  /** Phase H: how many live messages are already in the durable NDJSON log. */
  const loggedCountRef = useRef(0);
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
      titleRef.current = stored.title ?? null;
      createdAtRef.current = stored.createdAt ?? null;
      summaryRef.current = stored.summary;
      hydrate(stored.messages);
      pushSystem(`resumed session ${stored.id} — ${stored.messages.length} message(s)${stored.summary ? ' (older turns compacted)' : ''}. /new starts fresh.`);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Interrupt-and-redirect: once a cancelled/finished turn settles, resend the
  // queued message as a fresh turn.
  useEffect(() => {
    if (running || !redirectRef.current) return;
    const queued = redirectRef.current;
    redirectRef.current = null;
    void send(queued);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // Autosave whenever the transcript changes while idle. Long transcripts are
  // compacted on disk (recent tail + rolling summary); the live view is intact.
  // Phase H: every message is also appended to the NDJSON log-as-truth, which
  // is never compacted — forks replay from it.
  useEffect(() => {
    if (running || messages.length === 0) return;
    if (!createdAtRef.current) createdAtRef.current = new Date().toISOString();
    const compaction = compactTranscript(messages);
    if (compaction.summary) summaryRef.current = [summaryRef.current, compaction.summary].filter(Boolean).join('\n\n');
    const derivedTitle = messages.find((entry) => entry.role === 'user')?.text.slice(0, 48) ?? 'session';
    const pending = messages.slice(loggedCountRef.current);
    if (pending.length) {
      loggedCountRef.current = messages.length;
      void (async () => {
        for (const entry of pending) {
          try {
            await appendSessionLog(sessionIdRef.current, { type: entry.role, text: entry.text });
          } catch { /* log append is best-effort; snapshot remains */ }
        }
      })();
    }
    void saveSession({
      id: sessionIdRef.current,
      title: titleRef.current ?? derivedTitle,
      createdAt: createdAtRef.current,
      updatedAt: new Date().toISOString(),
      messages: compaction.messages,
      summary: summaryRef.current,
      version: SESSION_SCHEMA_VERSION,
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
    const needle = input.slice(1).split(/\s+/)[0] ?? '';
    if (!needle.trim()) return [...commands];
    // Fuzzy (Phase 0.8): match anywhere in the name or description —
    // "pvdr" finds /providers, "approve" finds /skills via its description —
    // ranked by the same matcher the Ctrl-K palette uses.
    return commands
      .map((command) => ({
        command,
        score: Math.max(fuzzyScore(needle, command.name), fuzzyScore(needle, `${command.name} ${command.description ?? ''}`) - 5),
      }))
      .filter((entry) => entry.score >= 0)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.command);
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

  const submit = async () => {
    const raw = input.trim();
    setInput('');
    setSelectedIndex(0);
    if (!raw) return;
    setHistory((previous) => (previous[previous.length - 1] === raw ? previous : [...previous, raw]));
    setHistoryIndex(-1);
    draftRef.current = '';
    if (!raw.startsWith('/')) {
      if (handleOnboardingInput(raw)) return;
      // @mention (Phase F): inline `@agent` tokens hint at subagent delegation.
      // Registry scan only runs when the text actually contains '@'.
      if (raw.includes('@')) {
        const mentions = extractAgentMentions(raw, listAgentsSync(process.cwd()).map((agent) => agent.name));
        if (mentions.length) pushSystem(`delegating hint: @${mentions.join(' @')}`);
      }
      if (running) {
        // Interrupt-and-redirect (Phase D): a new message during a run cancels
        // the turn and resends as soon as it settles.
        redirectRef.current = raw;
        cancel();
        pushSystem(`↩ cancelling current turn — will redirect to: ${raw.slice(0, 60)}`);
        return;
      }
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
      titleRef.current = null;
      createdAtRef.current = null;
      summaryRef.current = undefined;
      loggedCountRef.current = 0;
      pushSystem('new session started');
      return;
    }
    if (command.name === 'rename') {
      const title = command.args.join(' ').trim();
      if (!title) { pushSystem('usage: /rename <new title>'); return; }
      const renamed = await renameSession(sessionIdRef.current, title);
      if (renamed) {
        titleRef.current = title.slice(0, 120);
        pushSystem(`session renamed to: ${titleRef.current}`);
      } else {
        pushSystem('rename will apply with the next autosave');
        titleRef.current = title.slice(0, 120);
      }
      return;
    }
    if (command.name === 'memory') {
      void (async () => {
        const [memory, user] = await Promise.all([
          loadMemory('memory'),
          loadMemory('user'),
        ]);
        const format = (label: string, entries: string[], used: number, limit: number) => {
          const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
          return [`${label} — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} · ${used}/${limit} chars (${pct}%)`, ...entries.slice(-6).map((entry) => `  · ${entry.length > 100 ? `${entry.slice(0, 100)}…` : entry.replace(/\n/g, ' ')}`)];
        };
        pushSystem([...format('memory', memory.entries, memory.used, memory.limit), '', ...format('user profile', user.entries, user.used, user.limit)].join('\n'));
      })();
      return;
    }
    if (command.name === 'show') {
      void (async () => {
        const id = command.args[0] ?? sessionIdRef.current;
        const stored = await loadSession(id);
        if (!stored) { pushSystem(`unknown session: ${id}`); return; }
        const recent = stored.messages.slice(-10);
        pushSystem([
          `session ${stored.id} — ${stored.title} (${stored.messages.length} msgs)`,
          ...recent.map((entry) => `  ${entry.role} › ${entry.text.length > 120 ? `${entry.text.slice(0, 120)}…` : entry.text.replace(/\n/g, ' ')}`),
          stored.summary ? '  [older turns compacted into the stored summary]' : '',
        ].filter(Boolean).join('\n'));
      })();
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
    if (command.name === 'fork') {
      void (async () => {
        const id = command.args[0] ?? sessionIdRef.current;
        const result = await forkSession(id, { cwd: process.cwd() });
        if (!result) { pushSystem(`unknown session: ${id}`); return; }
        pushSystem(`forked ${result.from} → ${result.session.id} (${result.copied} msgs). /resume ${result.session.id} to continue it.`);
      })();
      return;
    }
    if (command.name === 'transcript') {
      void (async () => {
        const id = command.args[0] ?? sessionIdRef.current;
        const full = await loadFullTranscript(id, process.cwd());
        if (!full.length) { pushSystem(`no durable transcript for ${id} (sessions from before 0.4.0 only keep the compacted snapshot — /show shows it)`); return; }
        pushSystem([
          `full transcript ${id} — ${full.length} message(s) from the log-as-truth`,
          ...full.slice(-12).map((entry) => `  ${entry.role} › ${entry.text.length > 120 ? `${entry.text.slice(0, 120)}…` : entry.text.replace(/\n/g, ' ')}`),
        ].join('\n'));
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
        // Restored history is already durable (snapshot + log); only new
        // turns append to the log from here.
        loggedCountRef.current = stored.messages.length;
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
      <HeaderChips
        provider={provider}
        model={model}
        projectName={projectName}
        totalTokens={status.totalTokens}
        elapsedMs={status.elapsedMs}
      />
      <Static items={messages}>
        {(message, index) => <MessageRow key={index} message={message} />}
      </Static>
      {streamingText ? <AgentBlock text={streamingText} streaming /> : null}
      <ToolTimeline events={toolEvents} />
      {running ? <ActivityIndicator label={activity ?? 'working… (Ctrl-C to cancel)'} /> : null}
      {lastError && !running ? <InlineError message={lastError} /> : null}
      {showExitConfirm ? <Text color="yellow">Press Ctrl+C again to exit</Text> : null}
      {menuOpen ? (
        <SlashMenu
          filtered={filtered}
          clampedIndex={clampedIndex}
          empty={filtered.length === 0}
        />
      ) : null}
      <Box borderStyle="round" borderColor={colors.border} paddingX={1}>
        <Text color={colors.accent}>❯ </Text>
        <Text>{input}</Text>
        <Text dimColor>▏</Text>
      </Box>
      <FooterHints />
    </Box>
  );
}

/** Sticky header: brand + live status chips (model, session mode, posture, tokens). */
function HeaderChips({
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
}): React.ReactElement {
  const tokens = totalTokens !== undefined
    ? totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}k tok` : `${totalTokens} tok`
    : undefined;
  let sessionMode: string | undefined;
  let posture: string | undefined;
  try {
    sessionMode = currentSessionMode();
    posture = currentPermissionMode();
  } catch { /* chips degrade gracefully */ }
  return (
    <Box flexWrap="wrap" columnGap={1}>
      <Text bold color={colors.bannerTitle}>◆ AgentForge</Text>
      {provider || model ? <Text dimColor>[{[provider, model].filter(Boolean).join('/')}]</Text> : null}
      {sessionMode ? <Text color={colors.accent}>[{sessionMode}]</Text> : null}
      {posture ? <Text color={colors.tool}>[{posture}]</Text> : null}
      {projectName ? <Text dimColor>[project:{projectName}]</Text> : null}
      {tokens ? <Text dimColor>[{tokens}]</Text> : null}
      {elapsedMs !== undefined && elapsedMs > 0 ? <Text dimColor>[{(elapsedMs / 1000).toFixed(1)}s]</Text> : null}
    </Box>
  );
}
