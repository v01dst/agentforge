import { useEffect, useState } from 'react';
import { Text } from 'ink';
import { asciiMode, glyphs, colors } from './theme.js';

const BRAILLE_FRAMES = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];
const ASCII_FRAMES = ['|', '/', '-', '\\'];
/** The Sculptor's Chisel: a golden ankh turning through carving phases. */
const ANKH_FRAMES = [glyphs.ankh, '\u25d0', glyphs.ankh, '\u25d1'];
const DOTS = ['', '.', '..', '...'];

function useFrameInterval(intervalMs: number, active = true): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setFrame((value) => (value + 1) % Math.max(BRAILLE_FRAMES.length, DOTS.length)), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return frame;
}

/**
 * Animated activity indicator: spinner frame + label + animated dots.
 * The spinner is the golden ankh (Pharaoh theme); ASCII and braille
 * fallbacks keep every terminal covered.
 */
export function ActivityIndicator({ label, detail }: { label: string; detail?: string }) {
  const frame = useFrameInterval(80);
  const glyph = asciiMode
    ? ASCII_FRAMES[frame % ASCII_FRAMES.length] ?? ''
    : ANKH_FRAMES[frame % ANKH_FRAMES.length] ?? BRAILLE_FRAMES[frame % BRAILLE_FRAMES.length] ?? '';
  const dots = DOTS[frame % DOTS.length] ?? '';
  return (
    <Text>
      <Text color={colors.bannerTitle}>{glyph}</Text> <Text color={colors.thinking}>{label}</Text>
      {dots ? <Text dimColor>{dots}</Text> : null}
      {detail ? <Text dimColor> ({detail})</Text> : null}
    </Text>
  );
}

export type StepState = 'pending' | 'active' | 'done' | 'error';

export interface StepInfo {
  label: string;
  state: StepState;
}

const STEP_GLYPHS: Record<StepState, string> = { pending: '\u00b7', active: '\u25cf', done: '\u2713', error: '\u00d7' };
const STEP_ASCII: Record<StepState, string> = { pending: '-', active: '>', done: '+', error: 'x' };
const STEP_COLORS: Record<StepState, string | undefined> = {
  pending: undefined,
  active: 'cyan',
  done: 'green',
  error: 'red',
};

/** Multi-step flow timeline with per-step state glyphs. */
export function StepTimeline({ steps }: { steps: readonly StepInfo[] }) {
  return (
    <>
      {steps.map((step) => {
        const glyph = (asciiMode ? STEP_ASCII : STEP_GLYPHS)[step.state];
        const text = `${glyph ?? ''} ${step.label}`;
        const color = STEP_COLORS[step.state];
        return <Text key={step.label} color={color} dimColor={!color}>{text}</Text>;
      })}
    </>
  );
}
