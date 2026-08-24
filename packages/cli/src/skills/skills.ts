import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface SkillInfo {
  name: string;
  description?: string;
  body?: string;
}

const SKILLS_DIR = '.agentforge/skills';

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

export async function listSkills(cwd = process.cwd()): Promise<SkillInfo[]> {
  let files: string[];
  try {
    files = (await readdir(skillsDir(cwd))).filter((file) => file.endsWith('.md')).sort();
  } catch {
    return [];
  }
  return await Promise.all(files.map(async (file) => {
    const parsed = parseFrontmatter(await readFile(join(skillsDir(cwd), file), 'utf8'));
    return { name: parsed.data.name || file.replace(/\.md$/, ''), description: parsed.data.description, body: parsed.body };
  }));
}

export function skillBodies(skills: readonly SkillInfo[], selected: readonly string[]): string[] {
  return skills.filter((skill) => selected.includes(skill.name) && skill.body).map((skill) => skill.body as string);
}
