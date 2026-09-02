/** Tiny theme module for the AgentForge shell — pure string helpers, no React. */

import { currentSkin } from '../skin.js';

/**
 * Color tokens used across the shell. Values resolve from the active skin at
 * access time, so components can keep using `colors.accent` statically while
 * `/skin` changes retheme every subsequent render. Hex values degrade to
 * ANSI-256 or plain text automatically under chalk's level detection.
 */
export const colors = {
  get accent() { return currentSkin().colors.uiAccent; },
  get success() { return currentSkin().colors.uiOk; },
  get uiOk() { return currentSkin().colors.uiOk; },
  get warn() { return currentSkin().colors.uiWarn; },
  get error() { return currentSkin().colors.uiError; },
  get dim() { return currentSkin().colors.bannerDim; },
  get tool() { return currentSkin().colors.uiTool; },
  get thinking() { return currentSkin().colors.uiThinking; },
  get label() { return currentSkin().colors.uiLabel; },
  get border() { return currentSkin().colors.bannerBorder; },
  get text() { return currentSkin().colors.bannerText; },
  get bannerTitle() { return currentSkin().colors.bannerTitle; },
} as const;

/** True when the terminal cannot render Unicode spinners/box-drawing. */
export const asciiMode: boolean = process.env.TERM === 'dumb' || !process.stdout.isTTY;

/**
 * Glyph tokens — the carved marks of the Pharaoh's Monument UI (0.9/1.0 line).
 * Resolved per access so `/skin` and asciiMode changes apply live. The
 * hieroglyph set renders in terminals with an Egyptian-Hieroglyphs font;
 * `AGENTFORGE_GLYPHS=ascii` (or a dumb terminal) swaps to plain marks.
 */
const GLYPH_UNICODE = {
  /** Eye of Horus — opens the Cartouche, heads the chisel. */
  eyeHorus: '𓂀',
  /** Ankh — life; the FORGE prompt and the carved mark. */
  ankh: '𓋴',
  /** Sceptre/ankh variant — the ONLINE indicator. */
  online: '𓋹',
  /** Scribe — the status tablet. */
  scribe: '𓁈',
  /** Owl — model. */
  owl: '𓃀',
  /** Reed — session. */
  reed: '𓂋',
  /** Scarab — tokens. */
  scarab: '𓆣',
  /** User mark — the scroll handed to the Pharaoh. */
  userMark: '▸',
  /** Agent mark — divine responses. */
  agentMark: '◆',
  /** System note mark. */
  noteMark: '𓂋',
  /** Pillar segment flanking agent words. */
  pillar: '│',
  /** Prompt glyph: `𓋴 FORGE > ` */
  prompt: '𓋴 FORGE > ',
} as const;

const GLYPH_ASCII = {
  eyeHorus: '>',
  ankh: '+',
  online: '*',
  scribe: '#',
  owl: '@',
  reed: '~',
  scarab: '$',
  userMark: '>',
  agentMark: '<',
  noteMark: '-',
  pillar: '|',
  prompt: 'FORGE > ',
} as const;

export type GlyphTokens = typeof GLYPH_UNICODE;

/**
 * Glyph mode resolution: ASCII when the terminal cannot render Unicode
 * (or AGENTFORGE_GLYPHS=ascii), Unicode when the environment explicitly
 * opts in (AGENTFORGE_GLYPHS=unicode) or when stdout is a real TTY.
 */
const glyphOverride = process.env.AGENTFORGE_GLYPHS === 'ascii';
const glyphForceUnicode = process.env.AGENTFORGE_GLYPHS === 'unicode';
const glyphModeAscii = glyphOverride || (!glyphForceUnicode && asciiMode);

/**
 * Live-resolving glyph facade: each property is an accessor so /skin-style
 * swaps and AGENTFORGE_GLYPHS apply immediately. A plain object of getters
 * (no Proxy — React probes symbols and Ink clones props deeply).
 */
export const glyphs: GlyphTokens = {
  get eyeHorus() { return glyphModeAscii ? GLYPH_ASCII.eyeHorus : GLYPH_UNICODE.eyeHorus; },
  get ankh() { return glyphModeAscii ? GLYPH_ASCII.ankh : GLYPH_UNICODE.ankh; },
  get online() { return glyphModeAscii ? GLYPH_ASCII.online : GLYPH_UNICODE.online; },
  get scribe() { return glyphModeAscii ? GLYPH_ASCII.scribe : GLYPH_UNICODE.scribe; },
  get owl() { return glyphModeAscii ? GLYPH_ASCII.owl : GLYPH_UNICODE.owl; },
  get reed() { return glyphModeAscii ? GLYPH_ASCII.reed : GLYPH_UNICODE.reed; },
  get scarab() { return glyphModeAscii ? GLYPH_ASCII.scarab : GLYPH_UNICODE.scarab; },
  get userMark() { return glyphModeAscii ? GLYPH_ASCII.userMark : GLYPH_UNICODE.userMark; },
  get agentMark() { return glyphModeAscii ? GLYPH_ASCII.agentMark : GLYPH_UNICODE.agentMark; },
  get noteMark() { return glyphModeAscii ? GLYPH_ASCII.noteMark : GLYPH_UNICODE.noteMark; },
  get pillar() { return glyphModeAscii ? GLYPH_ASCII.pillar : GLYPH_UNICODE.pillar; },
  get prompt() { return glyphModeAscii ? GLYPH_ASCII.prompt : GLYPH_UNICODE.prompt; },
} as GlyphTokens;

/** Gold `═══` temple-base separator of the given width (ASCII dashes fallback). */
export function templeRule(width: number): string {
  return glyphModeAscii ? '='.repeat(Math.max(0, width)) : '\u2550'.repeat(Math.max(0, width));
}

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
