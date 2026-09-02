import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Semantic skin palette — key names mirror proven terminal-skin schemas. */
export interface SkinPalette {
  bannerTitle: string;
  bannerAccent: string;
  bannerDim: string;
  bannerBorder: string;
  bannerText: string;
  uiAccent: string;
  uiOk: string;
  uiError: string;
  uiWarn: string;
  uiTool: string;
  uiThinking: string;
  uiLabel: string;
  diffAddedWord: string;
  diffRemovedWord: string;
  diffAddedBg: string;
  diffRemovedBg: string;
  syntaxString: string;
  syntaxNumber: string;
  syntaxKeyword: string;
  syntaxComment: string;
  prompt: string;
}

export interface Skin {
  name: string;
  description?: string;
  colors: SkinPalette;
}

const FORGE_COLORS: SkinPalette = {
  bannerTitle: '#FFD700',
  bannerAccent: '#FFBF00',
  bannerDim: '#B8860B',
  bannerBorder: '#CD7F32',
  bannerText: '#FFF8DC',
  uiAccent: '#FFBF00',
  uiOk: '#4caf50',
  uiError: '#ef5350',
  uiWarn: '#ffa726',
  uiTool: '#FFD700',
  uiThinking: '#CC9B1F',
  uiLabel: '#DAA520',
  diffAddedWord: '#4ade80',
  diffRemovedWord: '#f87171',
  diffAddedBg: '#12351c',
  diffRemovedBg: '#3b1212',
  syntaxString: '#FFBF00',
  syntaxNumber: '#FFF8DC',
  syntaxKeyword: '#CD7F32',
  syntaxComment: '#CC9B1F',
  prompt: '#FFF8DC',
};

/**
 * Pharaoh's Monument: obsidian black, Pharaoh's Gold, Nile turquoise, and
 * papyrus white — eternal, unshakable, carved in stone.
 */
const PHARAOH_COLORS: SkinPalette = {
  bannerTitle: '#D4A017',
  bannerAccent: '#C99A2A',
  bannerDim: '#8E8E8E',
  bannerBorder: '#C99A2A',
  bannerText: '#FDF5E6',
  uiAccent: '#48C9B0',
  uiOk: '#48C9B0',
  uiError: '#E67E22',
  uiWarn: '#E67E22',
  uiTool: '#48C9B0',
  uiThinking: '#E67E22',
  uiLabel: '#D4A017',
  diffAddedWord: '#48C9B0',
  diffRemovedWord: '#E67E22',
  diffAddedBg: '#0E2A26',
  diffRemovedBg: '#33200E',
  syntaxString: '#C99A2A',
  syntaxNumber: '#FDF5E6',
  syntaxKeyword: '#D4A017',
  syntaxComment: '#8E8E8E',
  prompt: '#FDF5E6',
};

/** Night sky over the desert — indigo ground, warmer gold, cool stone. */
const PHARAOH_INDIGO_COLORS: SkinPalette = {
  bannerTitle: '#E8C547',
  bannerAccent: '#D4A017',
  bannerDim: '#9BA8C0',
  bannerBorder: '#D4A017',
  bannerText: '#F5EFE0',
  uiAccent: '#48C9B0',
  uiOk: '#48C9B0',
  uiError: '#E67E22',
  uiWarn: '#E67E22',
  uiTool: '#48C9B0',
  uiThinking: '#E67E22',
  uiLabel: '#E8C547',
  diffAddedWord: '#48C9B0',
  diffRemovedWord: '#E67E22',
  diffAddedBg: '#0E2A26',
  diffRemovedBg: '#33200E',
  syntaxString: '#D4A017',
  syntaxNumber: '#F5EFE0',
  syntaxKeyword: '#E8C547',
  syntaxComment: '#9BA8C0',
  prompt: '#F5EFE0',
};

const MIDNIGHT_COLORS: SkinPalette = {  bannerTitle: '#22d3ee',
  bannerAccent: '#818cf8',
  bannerDim: '#64748b',
  bannerBorder: '#334155',
  bannerText: '#e5e7eb',
  uiAccent: '#22d3ee',
  uiOk: '#4ade80',
  uiError: '#f87171',
  uiWarn: '#fbbf24',
  uiTool: '#22d3ee',
  uiThinking: '#94a3b8',
  uiLabel: '#818cf8',
  diffAddedWord: '#4ade80',
  diffRemovedWord: '#f87171',
  diffAddedBg: '#0f2a1d',
  diffRemovedBg: '#3b1212',
  syntaxString: '#fbbf24',
  syntaxNumber: '#e5e7eb',
  syntaxKeyword: '#818cf8',
  syntaxComment: '#64748b',
  prompt: '#e5e7eb',
};

const PAPER_COLORS: SkinPalette = {
  bannerTitle: '#b45309',
  bannerAccent: '#92400e',
  bannerDim: '#6b7280',
  bannerBorder: '#9ca3af',
  bannerText: '#111827',
  uiAccent: '#b45309',
  uiOk: '#15803d',
  uiError: '#b91c1c',
  uiWarn: '#a16207',
  uiTool: '#92400e',
  uiThinking: '#6b7280',
  uiLabel: '#78350f',
  diffAddedWord: '#15803d',
  diffRemovedWord: '#b91c1c',
  diffAddedBg: '#dcfce7',
  diffRemovedBg: '#fee2e2',
  syntaxString: '#a16207',
  syntaxNumber: '#111827',
  syntaxKeyword: '#92400e',
  syntaxComment: '#6b7280',
  prompt: '#111827',
};

export const BUILT_IN_SKINS: Record<string, Skin> = {
  pharaoh: { name: 'pharaoh', description: "Pharaoh's Monument — gold on obsidian, pillars of turquoise", colors: PHARAOH_COLORS },
  'pharaoh-indigo': { name: 'pharaoh-indigo', description: 'Pharaoh on night-sky indigo', colors: PHARAOH_INDIGO_COLORS },
  forge: { name: 'forge', description: 'Gold/amber — the classic forge identity', colors: FORGE_COLORS },
  midnight: { name: 'midnight', description: 'Cyan/indigo on deep slate', colors: MIDNIGHT_COLORS },
  paper: { name: 'paper', description: 'Light-terminal friendly', colors: PAPER_COLORS },
};

export const DEFAULT_SKIN_NAME = 'pharaoh-indigo';

const PALETTE_KEYS = Object.keys(FORGE_COLORS) as Array<keyof SkinPalette>;

function mergePalette(base: SkinPalette, override: Partial<SkinPalette> | undefined): SkinPalette {
  if (!override) return { ...base };
  const merged = { ...base };
  for (const key of PALETTE_KEYS) {
    const value = override[key];
    if (typeof value === 'string' && value.trim()) merged[key] = value;
  }
  return merged;
}

export interface SkinSelectionFile {
  /** Preset name, e.g. "forge" | "midnight" | "paper". */
  skin?: string;
  /** Inline partial palette overriding whichever preset resolves. */
  colors?: Partial<SkinPalette>;
}

export function skinFilePath(cwd = process.cwd(), global = false): string {
  return global ? join(homedir(), '.agentforge', 'skin.json') : join(resolve(cwd), '.agentforge', 'skin.json');
}

async function readSelectionFile(path: string): Promise<SkinSelectionFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as SkinSelectionFile;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export interface ResolvedSkin {
  skin: Skin;
  /** Where each decision came from, most specific last. */
  sources: string[];
}

/**
 * Resolve the active skin: built-in selection plus optional palette overrides.
 * Precedence (lowest → highest): default preset, global file, project file,
 * explicit name, environment AGENTFORGE_SKIN.
 */
export async function resolveSkin(options: { name?: string; cwd?: string } = {}): Promise<ResolvedSkin> {
  const cwd = options.cwd ?? process.cwd();
  const sources: string[] = [`default:${DEFAULT_SKIN_NAME}`];
  let selected = DEFAULT_SKIN_NAME;
  let paletteOverride: Partial<SkinPalette> | undefined;

  const globalFile = await readSelectionFile(skinFilePath(cwd, true));
  if (globalFile?.skin && BUILT_IN_SKINS[globalFile.skin]) {
    selected = globalFile.skin;
    sources.push(`global:${skinFilePath(cwd, true)}`);
  }
  if (globalFile?.colors) paletteOverride = { ...paletteOverride, ...globalFile.colors };

  const projectFile = await readSelectionFile(skinFilePath(cwd));
  if (projectFile?.skin && BUILT_IN_SKINS[projectFile.skin]) {
    selected = projectFile.skin;
    sources.push('project:.agentforge/skin.json');
  }
  if (projectFile?.colors) paletteOverride = { ...paletteOverride, ...projectFile.colors };

  if (options.name && BUILT_IN_SKINS[options.name]) {
    selected = options.name;
    sources.push(`explicit:${options.name}`);
  }

  const envName = process.env.AGENTFORGE_SKIN;
  if (envName && BUILT_IN_SKINS[envName]) {
    selected = envName;
    sources.push(`env:${envName}`);
  }

  const base = BUILT_IN_SKINS[selected] ?? BUILT_IN_SKINS[DEFAULT_SKIN_NAME] ?? defaultSkin();
  return { skin: { name: base.name, description: base.description, colors: mergePalette(base.colors, paletteOverride) }, sources };
}

function defaultSkin(): Skin {
  const preset = BUILT_IN_SKINS[DEFAULT_SKIN_NAME];
  if (!preset) throw new Error(`missing built-in skin: ${DEFAULT_SKIN_NAME}`);
  return preset;
}

let active: Skin = defaultSkin();

/** Replace the process-wide active skin (called once at CLI startup). */
export function setActiveSkin(skin: Skin): void {
  active = skin;
}

/** The skin every surface should read from at render time. */
export function currentSkin(): Skin {
  return active;
}

export function listSkinNames(): string[] {
  return Object.keys(BUILT_IN_SKINS);
}

/** Persist a skin selection (preset name + optional inline palette overrides). */
export async function saveSkinSelection(selection: SkinSelectionFile, cwd = process.cwd(), global = false): Promise<string> {
  const path = skinFilePath(cwd, global);
  await mkdir(path.replace(/[/\\][^/\\]+$/, ''), { recursive: true });
  await writeFile(path, `${JSON.stringify(selection, null, 2)}\n`);
  return path;
}
