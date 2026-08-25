import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { asciiMode } from './theme.js';

const PULSE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const PULSE_ASCII = ['|', '/', '-', '\\'];

/**
 * Branded startup splash: centered brand + version, mode line,
 * provider/model line, and a subtle braille pulse. Shown briefly
 * (~600ms) before the main TUI mounts.
 */
export function StartupBanner({
  version,
  modeLine = 'GLOBAL SESSION',
  provider,
  model,
  ms = 600,
  onDone,
}: {
  version?: string;
  modeLine?: string;
  provider?: string;
  model?: string;
  /** Splash duration in ms; the caller should unmount when onDone fires. */
  ms?: number;
  /** Called once after `ms`; the entrypoint then mounts the real TUI. */
  onDone?: () => void;
}) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const spinner = setInterval(() => setFrame((value) => value + 1), 90);
    const doneTimer = setTimeout(() => onDone?.(), ms);
    return () => {
      clearInterval(spinner);
      clearTimeout(doneTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const frames = asciiMode ? PULSE_ASCII : PULSE_FRAMES;
  const glyph = frames[frame % frames.length] ?? '';
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} paddingY={1}>
      <Text bold color="cyan">
        {asciiMode ? '' : '◆ '}AgentForge{version ? ` v${version.replace(/^v/, '')}` : ''}
      </Text>
      <Text dimColor>{modeLine}</Text>
      {provider || model ? (
        <Text dimColor>{provider ?? ''}{model ? ` · ${model}` : ''}</Text>
      ) : null}
      <Text color="cyan">{glyph}</Text>
    </Box>
  );
}

/**
 * Hook driving the splash window: returns true once `ms` has elapsed
 * (splash done, mount the real interface).
 */
export function useSplash(ms = 600): boolean {
  const [done, setDone] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setDone(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return done;
}

export default StartupBanner;
