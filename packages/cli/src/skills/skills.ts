import { readdir, readFile, stat } from 'node:fs/promises';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface SkillInfo {
  name: string;
  description?: string;
  body?: string;
  /** Set for folder skills (skills/<name>/SKILL.md): the skill directory. */
  dir?: string;
}

const SKILLS_DIR = '.agentforge/skills';
const SKILL_FILE = 'SKILL.md';

/** Parse `---`-delimited YAML-ish frontmatter (key: value lines only). */
export function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match?.[1]) return { data: {}, body: raw.trim() };
  const data: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator > 0) data[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return { data, body: raw.slice(match[0].length).trim() };
}

export function skillsDir(cwd = process.cwd()): string {
  return join(resolve(cwd), SKILLS_DIR);
}

/**
 * Discover skills in two layouts (Phase B):
 * - folders: skills/<name>/SKILL.md (references/, scripts/ live beside it)
 * - flat: skills/<name>.md (legacy, still supported)
 */
export async function listSkills(cwd = process.cwd()): Promise<SkillInfo[]> {
  const base = skillsDir(cwd);
  let names: string[];
  try {
    names = (await readdir(base)).sort();
  } catch {
    return [];
  }
  const skills: SkillInfo[] = [];
  for (const name of names) {
    if (name.startsWith('.') || name.startsWith('_')) continue;
    const entryPath = join(base, name);
    let info;
    try {
      info = await stat(entryPath);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      const skillFile = join(entryPath, SKILL_FILE);
      try {
        const parsed = parseFrontmatter(await readFile(skillFile, 'utf8'));
        skills.push({
          name: parsed.data.name || name,
          description: parsed.data.description,
          body: parsed.body,
          dir: entryPath,
        });
      } catch {
        continue; // directory without SKILL.md is not a skill
      }
    } else if (name.endsWith('.md')) {
      const parsed = parseFrontmatter(await readFile(entryPath, 'utf8'));
      skills.push({ name: parsed.data.name || name.replace(/\.md$/, ''), description: parsed.data.description, body: parsed.body });
    }
  }
  return skills;
}

export function skillBodies(skills: readonly SkillInfo[], selected: readonly string[]): string[] {
  return skills.filter((skill) => selected.includes(skill.name) && skill.body).map((skill) => skill.body as string);
}

/** Synchronous twin of listSkills for runner factories that cannot await. */
export function listSkillsSync(cwd = process.cwd()): SkillInfo[] {
  const base = skillsDir(cwd);
  let names: string[];
  try {
    names = readdirSync(base).sort();
  } catch {
    return [];
  }
  const skills: SkillInfo[] = [];
  for (const name of names) {
    if (name.startsWith('.') || name.startsWith('_')) continue;
    const entryPath = join(base, name);
    let info;
    try {
      info = statSync(entryPath);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      try {
        const parsed = parseFrontmatter(readFileSync(join(entryPath, SKILL_FILE), 'utf8'));
        skills.push({ name: parsed.data.name || name, description: parsed.data.description, body: parsed.body, dir: entryPath });
      } catch {
        continue;
      }
    } else if (name.endsWith('.md')) {
      try {
        const parsed = parseFrontmatter(readFileSync(entryPath, 'utf8'));
        skills.push({ name: parsed.data.name || name.replace(/\.md$/, ''), description: parsed.data.description, body: parsed.body });
      } catch {
        continue;
      }
    }
  }
  return skills;
}

/** Progressive disclosure level 0: the compact index for the system prompt. */
export function renderSkillIndex(skills: readonly SkillInfo[]): string | undefined {
  if (!skills.length) return undefined;
  const lines = skills.map((skill) => `- ${skill.name}${skill.description ? `: ${skill.description}` : ''}`);
  return `[skills available — load one with the skill_view tool when relevant]\n${lines.join('\n')}`;
}

/** Level 2: read a reference/support file inside a skill folder (escape-safe). */
export async function readSkillReference(dir: string, relativePath: string): Promise<string> {
  const full = resolve(dir, relativePath);
  const rel = relative(dir, full);
  if (rel.startsWith('..') || isAbsolute(rel) || rel === '') {
    throw new Error(`Reference path escapes the skill directory: ${relativePath}`);
  }
  return readFile(full, 'utf8');
}

/** Files inside a skill folder available as references (relative paths). */
export async function listSkillReferences(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(current);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const full = join(current, name);
      const info = await stat(full).catch(() => undefined);
      if (!info) continue;
      if (info.isDirectory()) await walk(full);
      else if (name !== SKILL_FILE) out.push(relative(dir, full).split('\\').join('/'));
    }
  };
  await walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// Staged skill writes (write-approval gate, Phase B)
// ---------------------------------------------------------------------------

export type SkillWriteAction = 'create' | 'patch' | 'delete' | 'write_file';

export interface StagedSkillWrite {
  id: string;
  action: SkillWriteAction;
  skill: string;
  /** create/edit: full SKILL.md content. patch: old/new strings. write_file: file content. */
  content?: string;
  oldString?: string;
  filePath?: string;
  createdAt: string;
}

export function pendingSkillsDir(cwd = process.cwd()): string {
  return join(resolve(cwd), '.agentforge', 'pending', 'skills');
}

function sanitizeSkillName(name: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(name)) {
    throw new Error(`Invalid skill name: ${name}`);
  }
  return name;
}

/** Persist a proposal for review; returns the staged id. */
export async function stageSkillWrite(proposal: Omit<StagedSkillWrite, 'id' | 'createdAt'>, cwd = process.cwd()): Promise<string> {
  const staged: StagedSkillWrite = {
    ...proposal,
    skill: sanitizeSkillName(proposal.skill),
    id: `sk-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    createdAt: new Date().toISOString(),
  };
  const { mkdir, writeFile } = await import('node:fs/promises');
  const dir = pendingSkillsDir(cwd);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${staged.id}.json`), JSON.stringify(staged, null, 2), 'utf8');
  return staged.id;
}

export async function listStagedWrites(cwd = process.cwd()): Promise<StagedSkillWrite[]> {
  const { readdir, readFile } = await import('node:fs/promises');
  const dir = pendingSkillsDir(cwd);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((file) => file.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const staged: StagedSkillWrite[] = [];
  for (const file of files) {
    try {
      staged.push(JSON.parse(await readFile(join(dir, file), 'utf8')) as StagedSkillWrite);
    } catch {
      continue;
    }
  }
  return staged;
}

async function loadStaged(id: string, cwd: string): Promise<StagedSkillWrite> {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid staged id: ${id}`);
  const raw = await readFile(join(pendingSkillsDir(cwd), `${id}.json`), 'utf8');
  return JSON.parse(raw) as StagedSkillWrite;
}

async function applyStaged(staged: StagedSkillWrite, cwd: string): Promise<string> {
  const { mkdir, writeFile, rm } = await import('node:fs/promises');
  const base = skillsDir(cwd);
  const skillDir = join(base, staged.skill);
  switch (staged.action) {
    case 'create': {
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, SKILL_FILE), staged.content ?? '', 'utf8');
      return `Created skill '${staged.skill}'.`;
    }
    case 'write_file': {
      if (!staged.filePath || !staged.content) throw new Error('write_file requires filePath and content');
      const target = resolve(skillDir, staged.filePath);
      const rel = relative(skillDir, target);
      if (rel.startsWith('..') || isAbsolute(rel) || rel === '') throw new Error(`filePath escapes the skill directory: ${staged.filePath}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, staged.content, 'utf8');
      return `Wrote ${staged.filePath} in skill '${staged.skill}'.`;
    }
    case 'patch': {
      if (staged.oldString === undefined || staged.content === undefined) throw new Error('patch requires oldString and content');
      const skillFile = join(skillDir, SKILL_FILE);
      const raw = await readFile(skillFile, 'utf8');
      if (!raw.includes(staged.oldString)) throw new Error(`Patch does not apply: '${staged.oldString.slice(0, 60)}' not found in SKILL.md`);
      await writeFile(skillFile, raw.replace(staged.oldString, staged.content), 'utf8');
      return `Patched skill '${staged.skill}'.`;
    }
    case 'delete': {
      await rm(skillDir, { recursive: true, force: true });
      return `Deleted skill '${staged.skill}'.`;
    }
  }
}

/** Apply a staged proposal; removes the pending file either way. Returns the outcome message. */
export async function approveStagedWrite(id: string, cwd = process.cwd()): Promise<string> {
  const staged = await loadStaged(id, cwd);
  const message = await applyStaged(staged, cwd);
  const { unlink } = await import('node:fs/promises');
  await unlink(join(pendingSkillsDir(cwd), `${id}.json`)).catch(() => {});
  return message;
}

/** Drop a staged proposal. Returns false when the id is unknown. */
export async function rejectStagedWrite(id: string, cwd = process.cwd()): Promise<boolean> {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid staged id: ${id}`);
  const { unlink } = await import('node:fs/promises');
  try {
    await unlink(join(pendingSkillsDir(cwd), `${id}.json`));
    return true;
  } catch {
    return false;
  }
}
