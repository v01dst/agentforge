/** Tiny theme module for the AgentForge shell — pure string helpers, no React. */

/** Color tokens used across the shell (values are standard Ink color names). */
export const colors = {
  accent: 'cyan',
  success: 'green',
  warn: 'yellow',
  error: 'red',
  dim: 'gray',
} as const;

/** True when the terminal cannot render Unicode spinners/box-drawing. */
export const asciiMode: boolean = process.env.TERM === 'dumb' || !process.stdout.isTTY;

export type BadgeState = 'ready' | 'missing' | 'idle';

const BADGE_GLYPHS: Record<BadgeState, string> = { ready: '\u2713', missing: '!', idle: '\u00b7' };
const BADGE_ASCII: Record<BadgeState, string> = { ready: '+', missing: '!', idle: '-' };
const BADGE_COLORS: Record<BadgeState, string> = {
  ready: colors.success,
  missing: colors.warn,
  idle: colors.dim,
};

/** Render a doctor-style status badge glyph (`✓`, `!`, `·`) with an ASCII fallback. */
export function badgeGlyph(state: BadgeState): string {
  return asciiMode ? BADGE_ASCII[state] : BADGE_GLYPHS[state];
}

/** Color name for a badge state (pass to Ink `<Text color=...>`). */
export function badgeColor(state: BadgeState): string {
  return BADGE_COLORS[state];
}

/** Render a full plain-text badge like `✓ ready`. */
export function badge(state: BadgeState): string {
  return `${badgeGlyph(state)} ${state}`;
}

/** Render a section header line like `── Project ──` (ASCII dashes under asciiMode). */
export function sectionHeader(title: string): string {
  return asciiMode ? `-- ${title} --` : `\u2500\u2500 ${title} \u2500\u2500`;
}
