import React from 'react';
import { Box, Text, useInput } from 'ink';
import { type ScreenProps } from './screens-common.js';

/** UI key ↔ CLI command mapping, exported so the shell can reuse it. */
export interface Shortcut {
  keys: string;
  action: string;
  cli: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  // Navigation
  { keys: 'Esc', action: 'Back / close overlay', cli: '—' },
  { keys: '↑/↓', action: 'Move selection', cli: '—' },
  { keys: '←/→', action: 'Switch tabs', cli: '—' },
  { keys: 'Enter', action: 'Select / apply', cli: '—' },
  // Chat
  { keys: 'type + Enter', action: 'Chat with agent', cli: 'agentforge chat' },
  { keys: '/skills', action: 'List and toggle skills', cli: 'agentforge skills list' },
  { keys: '/help', action: 'Show help', cli: 'agentforge --help' },
  // Shortcuts (management screens)
  { keys: 'm', action: 'Models & endpoints screen', cli: 'agentforge models list' },
  { keys: 's', action: 'Session settings', cli: 'agentforge config' },
  { keys: '?', action: 'This help overlay', cli: 'agentforge --help' },
  { keys: 'a', action: 'Add endpoint', cli: 'agentforge providers add <name>' },
  { keys: 'd', action: 'Delete endpoint (press twice)', cli: 'agentforge providers remove <name>' },
  // CLI equivalents
  { keys: '/models', action: 'Model readiness report', cli: 'agentforge models list' },
  { keys: '/doctor', action: 'Environment diagnostics', cli: 'agentforge doctor' },
];

const SECTION_TITLES = ['Navigation', 'Chat', 'Shortcuts', 'CLI equivalents'] as const;

/** Full-screen help overlay: purely presentational, closes on any key via onBack. */
export function HelpOverlay({ onBack }: ScreenProps = {}): React.ReactElement {
  useInput(() => { if (onBack) onBack(); });
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>AgentForge — Help</Text>
      <Text dimColor>Press any key to close</Text>
      {SECTION_TITLES.map((title) => (
        <Box key={title} flexDirection="column" marginTop={1}>
          <Text bold underline>{title}</Text>
          {SHORTCUTS.map((shortcut) => (
            <Text key={`${title}:${shortcut.keys}:${shortcut.action}`}>
              {' '}
              {shortcut.keys.padEnd(14)} {shortcut.action}
              {shortcut.cli !== '—' ? `  ↔  ${shortcut.cli}` : ''}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}

export default HelpOverlay;
