import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ComponentType, ReactElement } from 'react';
import type { RenderOptions } from 'ink';
import { render } from 'ink';
import { ActivityIndicator } from './Activity.js';
import { CommandPalette, type PaletteAction } from './palette.js';
import type { DashboardActions } from './Dashboard.js';

export type ScreenId =
  | 'dashboard' | 'chat-home' | 'chat' | 'run' | 'new-project' | 'tools'
  | 'workflows' | 'models' | 'doctor' | 'settings' | 'help'
  | 'agents' | 'runs' | 'inspect' | 'skills' | 'doctor-result';

export interface ShellProps {
  /** Optional screen components supplied by other agents; missing ones show a placeholder. */
  screens?: Partial<Record<ScreenId, ComponentType>>;
  /** Palette actions (built by actions.ts from real commands). */
  actions?: readonly PaletteAction[];
  /** Overrides for dashboard quick-action handlers; defaults switch screens. */
  dashboardActions?: Partial<DashboardActions>;
  /** Initial screen (used by tests/headless embedding). */
  initialScreen?: ScreenId;
  /**
   * When set, the dashboard is replaced by a chat-first home (ChatHome).
   * The runner drives agent turns; slash commands route through onSlash.
   */
  chatHome?: {
    runner: import('../turn.js').TurnRunner;
    provider?: string;
    model?: string;
    registry?: ComponentType;
  };
}

const SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ['Ctrl+K', 'open command palette'],
  ['?', 'toggle this help overlay'],
  ['Esc', 'return to dashboard'],
  ['up/down + enter', 'navigate menus'],
  ['Ctrl+C', 'quit'],
];

function HelpOverlay() {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Keyboard shortcuts</Text>
      {SHORTCUTS.map(([keys, description]) => (
        <Text key={keys}><Text color="cyan">{keys}</Text> - {description}</Text>
      ))}
      <Text dimColor>press ? or Esc to close</Text>
    </Box>
  );
}

/**
 * Shell/router: renders the active screen with global Ctrl+K palette,
 * '?' help overlay and Esc-to-dashboard navigation. When `chatHome` is set
 * the dashboard IS the chat (ChatHome): the persistent conversation input
 * with inline slash-command suggestions.
 */
export function Shell({ screens = {}, actions = [], dashboardActions = {}, initialScreen = 'dashboard', chatHome }: ShellProps) {
  const [screen, setScreen] = useState<ScreenId>(initialScreen);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  useInput((input, key) => {
    if (key.ctrl && input === 'k') { setPaletteOpen(true); return; }
    if (paletteOpen) return;
    if (key.escape) { setHelpOpen(false); setScreen('dashboard'); return; }
    if (input === '?') setHelpOpen(!helpOpen);
  });

  const overlay: ReactElement | null = paletteOpen
    ? <CommandPalette actions={actions} onClose={() => setPaletteOpen(false)} />
    : helpOpen ? <HelpOverlay /> : null;

  const go = (next: ScreenId) => () => setScreen(next);
  const handlers: DashboardActions = {
    onChat: dashboardActions.onChat ?? go('chat'),
    onRun: dashboardActions.onRun ?? go('run'),
    onNewProject: dashboardActions.onNewProject ?? go('new-project'),
    onTools: dashboardActions.onTools ?? go('tools'),
    onWorkflows: dashboardActions.onWorkflows ?? go('workflows'),
    onModels: dashboardActions.onModels ?? go('models'),
    onTest: dashboardActions.onTest ?? go('doctor'),
    onDoctor: dashboardActions.onDoctor ?? go('doctor'),
    onSettings: dashboardActions.onSettings ?? go('settings'),
    onPalette: dashboardActions.onPalette ?? (() => setPaletteOpen(true)),
  };

  const Screen = screen === 'dashboard' ? undefined : screens[screen];
  const ChatHomeScreen = chatHome ? screens['chat-home' as ScreenId] : undefined;
  return (
    <Box flexDirection="column">
      {screen === 'dashboard'
        ? (!overlay && (chatHome && ChatHomeScreen
            ? <ChatHomeScreen />
            : <Dashboard {...handlers} active={!overlay} />))
        : Screen
          ? <Screen />
          : <ActivityIndicator label="Coming soon" />}
      {overlay}
    </Box>
  );
}

import { Dashboard } from './Dashboard.js';

/** Alias expected by src/interactive.ts. */
export const AppShell = Shell;

/** Mount the shell with ink's render() and return the instance for suspension control. */
export function renderShell(props: ShellProps = {}, options: RenderOptions = {}) {
  return render(<Shell {...props} />, options);
}
