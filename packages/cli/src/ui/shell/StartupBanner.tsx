import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { asciiMode, colors } from './theme.js';
import { currentSkin } from '../skin.js';

const PULSE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const PULSE_ASCII = ['|', '/', '-', '\\'];

/** ANSI-shadow block letters, stacked two words to fit narrow terminals. */
const WORDMARK_AGENT = [
  '██╗    ██╗ ██████╗  ██████╗ ███╗   ██╗████████╗',
  '██║    ██║██╔════╝ ██╔════╝ ████╗  ██║╚══██╔══╝',
  '███████║██║  ███╗██║  ███╗██╔██╗ ██║   ██║   ',
  '██╔══██║██║   ██║██║   ██║██║╚██╗██║   ██║   ',
  '██║  ██║╚██████╔╝╚██████╔╝██║ ╚████║   ██║   ',
  '╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═══╝   ╚═╝   ',
];
const WORDMARK_FORGE = [
  '███████╗ ██████╗  ██████╗  ██████╗ ███████╗',
  '██╔════╝ ██╔══██╗██╔════╝ ██╔════╝ ██╔════╝',
  '█████╗  ██████╔╝██║  ███╗██║  ███╗█████╗  ',
  '██╔══╝  ██╔══██╗██║   ██║██║   ██║██╔══╝  ',
  '██║     ██║  ██║╚██████╔╝╚██████╔╝███████╗',
  '╚═╝     ╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚══════╝',
];

function Wordmark() {
  const skin = currentSkin();
  const c = skin.colors;
  const ramp = [c.bannerTitle, c.bannerTitle, c.bannerAccent, c.bannerBorder, c.bannerDim, c.bannerDim];
  return (
    <Box flexDirection="column" alignItems="center">
      {WORDMARK_AGENT.map((row, index) => (
        <Text key={`a${index}`} color={ramp[index]}>{row}</Text>
      ))}
      <Text> </Text>
      {WORDMARK_FORGE.map((row, index) => (
        <Text key={`f${index}`} color={ramp[index]}>{row}</Text>
      ))}
    </Box>
  );
}

/**
 * Branded startup splash: gold-gradient block-letter wordmark (forge skin),
 * tagline, version/mode/provider line and a live pulse. Falls back to a
 * compact single-line brand under ASCII/no-color terminals.
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
  if (asciiMode) {
    return (
      <Box flexDirection="column" alignItems="center" flexGrow={1} paddingY={1}>
        <Text bold>{`AgentForge${version ? ` v${version.replace(/^v/, '')}` : ''}`}</Text>
        <Text>{modeLine}</Text>
        <Text>{glyph}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} paddingY={1}>
      <Wordmark />
      <Box marginTop={1} flexDirection="column" alignItems="center">
        <Text color={colors.label}>forge agents · plugins · mcp · skills</Text>
        <Text dimColor>{modeLine}{version ? ` · v${version.replace(/^v/, '')}` : ''}</Text>
        {provider || model ? (
          <Text dimColor>{provider ?? ''}{model ? ` · ${model}` : ''}</Text>
        ) : null}
        <Text color={colors.accent}>{glyph}</Text>
      </Box>
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
