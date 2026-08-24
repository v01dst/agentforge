import { useEffect, useState } from 'react';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { parseSlashCommand } from './turn.js';
import { useTurn } from './useTurn.js';
import type { TurnRunner } from './turn.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface SkillInfo {
  name: string;
  description?: string;
  body?: string;
}

export interface ChatExtensions {
  plugins: readonly string[];
  mcpServers: readonly string[];
}

export interface ChatAppProps {
  runner: TurnRunner;
  provider?: string;
  model?: string;
  skills?: readonly SkillInfo[];
  extensions?: ChatExtensions;
  /** Commands/submissions processed once on mount (used by headless tests). */
  initialCommands?: readonly string[];
}

function Spinner({ active }: { active: boolean }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setFrame((value) => (value + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, [active]);
  if (!active) return null;
  return <Text color="cyan">{SPINNER_FRAMES[frame]}</Text>;
}

function MessageRow({ role, text }: { role: 'user' | 'assistant' | 'system'; text: string }) {
  if (role === 'user') return <Text><Text color="green">you   › </Text>{text}</Text>;
  if (role === 'system') return <Text dimColor>note  › {text}</Text>;
  return <Text><Text color="cyan">agent › </Text>{text}</Text>;
}

export function ChatApp({ runner, provider = 'mock', model, skills = [], extensions, initialCommands }: ChatAppProps) {
  const { exit } = useApp();
  const { messages, streamingText, running, status, send, cancel, clear, pushSystem } = useTurn(runner);
  const [input, setInput] = useState('');
  const [activeSkills, setActiveSkills] = useState<readonly string[]>([]);

  const handleRaw = (raw: string) => {
    const command = parseSlashCommand(raw);
    if (command) {
      switch (command.name) {
          case 'help':
            pushSystem('Commands: /help /clear /skills [name] /plugins /mcp /exit — Ctrl-C cancels a running turn or exits.');
            return;
          case 'clear':
            clear();
            return;
          case 'exit':
          case 'quit':
            exit();
            return;
          case 'skills': {
            const target = command.args[0];
            if (!target) {
              const list = skills.length ? skills.map((skill) => skill.name).join(', ') : '(none found in .agentforge/skills)';
              pushSystem(`Skills${activeSkills.length ? ` | active: ${activeSkills.join(', ')}` : ''}: ${list}`);
              return;
            }
            const skill = skills.find((candidate) => candidate.name === target);
            if (!skill) { pushSystem(`Unknown skill: ${target}`); return; }
            setActiveSkills((previous) => previous.includes(target) ? previous.filter((name) => name !== target) : [...previous, target]);
            return;
          }
          case 'plugins':
            pushSystem(`Plugins: ${extensions?.plugins.length ? extensions.plugins.join(', ') : '(none configured)'}`);
            return;
          case 'mcp':
            pushSystem(`MCP servers: ${extensions?.mcpServers.length ? extensions.mcpServers.join(', ') : '(none configured)'}`);
            return;
          default:
            pushSystem(`Unknown command: ${raw}. Type /help.`);
            return;
        }
      }
      void send(raw, activeSkills);
  };

  useEffect(() => {
    if (!initialCommands?.length) return;
    let cancelled = false;
    void (async () => {
      for (const command of initialCommands) {
        if (cancelled) return;
        const raw = command.trim();
        if (raw) handleRaw(raw);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((value, key) => {
    if (key.ctrl && value === 'c') {
      if (running) { cancel(); return; }
      exit();
      return;
    }
    if (running) return;
    if (key.return) {
      const raw = input.trim();
      setInput('');
      if (raw) handleRaw(raw);
      return;
    }
    if (key.backspace || key.delete) { setInput((current) => current.slice(0, -1)); return; }
    if (key.upArrow || key.downArrow || key.tab || key.escape) return;
    if (value) setInput((current) => current + value);
  });

  const skillSuffix = activeSkills.length ? ` · skills: ${activeSkills.join(',')}` : '';

  return (
    <Box flexDirection="column">
      <Static items={messages}>
        {(message, index) => <MessageRow key={index} role={message.role} text={message.text} />}
      </Static>
      {streamingText ? <MessageRow role="assistant" text={streamingText} /> : null}
      <Box marginTop={1} gap={1}>
        <Spinner active={running} />
        {running ? <Text dimColor>working… (Ctrl-C to cancel)</Text> : null}
      </Box>
      <Box borderStyle="round" paddingX={1}>
        <Text color="green">❯ </Text>
        <Text>{input}</Text>
        <Text dimColor>▏</Text>
      </Box>
      <Box marginTop={1} gap={2}>
        <Text dimColor>{provider}{model ? ` · ${model}` : ''}</Text>
        <Text dimColor>plugins: {extensions?.plugins.length ?? 0} · mcp: {extensions?.mcpServers.length ?? 0}{skillSuffix}</Text>
        {status.totalTokens !== undefined ? <Text dimColor>tokens: {status.totalTokens}</Text> : null}
        {status.elapsedMs !== undefined ? <Text dimColor>last: {(status.elapsedMs / 1000).toFixed(1)}s</Text> : null}
      </Box>
    </Box>
  );
}
