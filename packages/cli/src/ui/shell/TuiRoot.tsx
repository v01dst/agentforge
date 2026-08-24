import React, { useCallback, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import type { ComponentType } from 'react';
import { ChatHome } from './ChatHome.js';
import type { TurnRunner } from '../turn.js';
import {
  buildSlashRegistry,
  type SlashHandlers,
  type SlashScreen,
} from '../slash/registry.js';

export interface TuiRootProps {
  runner: TurnRunner;
  provider?: string;
  model?: string;
  /** Unmount ink, run a stdout-printing command, wait for Enter, remount. */
  runSuspended: (fn: () => Promise<number>) => Promise<void>;
  onExit: () => void;
  /** Screen components keyed by SlashScreen id. */
  screens: Partial<Record<SlashScreen, ComponentType>>;
}

/**
 * Root of the chat-first TUI: ChatHome is the persistent home screen and
 * slash commands navigate to management screens or suspend into real CLI
 * commands. Screens are rendered in place; Esc returns to the conversation.
 */
export function TuiRoot({ screens = {}, runner, provider, model, runSuspended, onExit }: TuiRootProps): React.ReactElement {
  const [activeScreen, setActiveScreen] = useState<{ id: SlashScreen | null; arg?: string }>({ id: null });

  const handlers: SlashHandlers = useMemo(() => ({
    openScreen: (id: SlashScreen, arg?: string) => setActiveScreen({ id, arg }),
    runSuspended,
    pushSystem: () => { /* system notes render inside ChatHome via commands like /status */ },
    clearConversation: () => { /* ChatHome owns its message state; Ctrl+L clears */ },
    exitRequested: onExit,
  }), [runSuspended, onExit]);

  const registry = useMemo(() => buildSlashRegistry(handlers), [handlers]);

  const onSlashCommand = useCallback((name: string, args: string[]) => {
    const entry = registry.find((candidate) => candidate.name === name);
    if (!entry) return; // ChatHome already reports unknown commands
    void entry.action(args);
  }, [registry]);

  const commands = useMemo(
    () => registry.map(({ name, description, usage }) => ({ name, description, usage })),
    [registry],
  );

  // Render the active management screen instead of the conversation.
  const Active = activeScreen.id ? screens[activeScreen.id] : undefined;
  if (activeScreen.id && Active) {
    const ArgScreen = Active as ComponentType<{ arg?: string; onBack?: () => void }>;
    return (
      <Box flexDirection="column">
        <ArgScreen arg={activeScreen.arg} onBack={() => setActiveScreen({ id: null })} />
        <Text dimColor>[Esc] back to chat</Text>
      </Box>
    );
  }

  return (
    <ChatHome
      runner={runner}
      commands={commands}
      onSlashCommand={onSlashCommand}
      provider={provider}
      model={model}
    />
  );
}
