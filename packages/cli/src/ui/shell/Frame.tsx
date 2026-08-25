import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { asciiMode } from './theme.js';

const BRAND_GLYPH = '◆';

export type FrameMode =
  | { kind: 'global' }
  | { kind: 'project'; name: string };

export interface FrameProps {
  children?: ReactNode;
  /** Session mode badge rendered in the center of the header bar. */
  mode?: FrameMode;
  /** Version string shown at the right edge of the header bar. */
  version?: string;
  /** Provider/model shown right-aligned in the footer. */
  provider?: string;
  model?: string;
}

/** Brand label: `◆ AgentForge` (or plain `AgentForge` under asciiMode). */
export function brandLabel(): string {
  return `${asciiMode ? '' : `${BRAND_GLYPH} `}AgentForge`;
}

/** Mode badge text for the header center: dim cyan global or green project. */
export function ModeBadge({ mode }: { mode?: FrameMode }) {
  if (!mode || mode.kind === 'global') {
    return <Text color="cyan" dimColor>GLOBAL SESSION</Text>;
  }
  return <Text color="green">PROJECT: {mode.name}</Text>;
}

/**
 * Reusable application frame: branded single-line top border (header bar)
 * plus a one-line hint footer. Children fill the remaining vertical space.
 */
export function Frame({ children, mode, version, provider, model }: FrameProps) {
  const brand = brandLabel();
  return (
    <Box flexDirection="column" width="100%">
      <Box
        borderStyle="round"
        flexDirection="column"
        paddingX={1}
        width="100%"
      >
        <Box justifyContent="space-between">
          <Text bold color="cyan">{brand}</Text>
          <ModeBadge mode={mode} />
          <Text dimColor>{version ? `v${version.replace(/^v/, '')}` : ''}</Text>
        </Box>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
      <Box justifyContent="space-between" paddingX={1}>
        <Text dimColor>
          [Enter] send{' '}
          [/] commands{' '}
          [Ctrl+K] palette{' '}
          [Esc] close{' '}
          [Ctrl+C] cancel
        </Text>
        <Text dimColor>{provider ?? ''}{model ? ` · ${model}` : ''}</Text>
      </Box>
    </Box>
  );
}
