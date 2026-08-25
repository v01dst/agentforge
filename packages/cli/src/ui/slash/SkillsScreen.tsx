import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listSkills, parseFrontmatter, type SkillInfo } from '../../skills/skills.js';
import { globalConfigDir } from './local-global-config.js';

type SkillScope = 'project' | 'global';
type ScopedSkill = SkillInfo & { scope: SkillScope };

function bodyPreview(body: string | undefined): string[] {
  if (!body) return [];
  return body.split(/\r?\n/).slice(0, 20);
}

async function listGlobalSkills(): Promise<SkillInfo[]> {
  const dir = join(globalConfigDir(), 'skills');
  let files: string[];
  try {
    files = (await readdir(dir)).filter((file) => file.endsWith('.md')).sort();
  } catch {
    return [];
  }
  return await Promise.all(files.map(async (file) => {
    try {
      const parsed = parseFrontmatter(await readFile(join(dir, file), 'utf8'));
      return { name: parsed.data.name || file.replace(/\.md$/, ''), description: parsed.data.description, body: parsed.body };
    } catch {
      return { name: file.replace(/\.md$/, '') };
    }
  }));
}

/** Project skills (.agentforge/skills of cwd) merged with global ones; project wins on name clash. */
async function loadScopedSkills(): Promise<ScopedSkill[]> {
  const [project, global] = await Promise.all([
    listSkills().catch((): SkillInfo[] => []),
    listGlobalSkills(),
  ]);
  const merged = new Map<string, ScopedSkill>();
  for (const skill of global) merged.set(skill.name, { ...skill, scope: 'global' });
  for (const skill of project) merged.set(skill.name, { ...skill, scope: 'project' });
  return [...merged.values()];
}

export function SkillsScreen({ onBack }: { onBack?: () => void }): React.ReactElement {
  const [skills, setSkills] = useState<ScopedSkill[] | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [active, setActive] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    void loadScopedSkills()
      .then((loaded) => { if (alive) setSkills(loaded); })
      .catch(() => { if (alive) setSkills([]); });
    return () => { alive = false; };
  }, []);

  const filtered = (skills ?? []).filter((skill) =>
    query === ''
    || skill.name.toLowerCase().includes(query.toLowerCase())
    || (skill.description ?? '').toLowerCase().includes(query.toLowerCase()),
  );
  const index = Math.min(selected, Math.max(0, filtered.length - 1));
  const current = filtered[index];

  useInput((input, key) => {
    if (key.escape) {
      if (query) { setQuery(''); return; }
      onBack?.();
      return;
    }
    if (skills === null) return;
    if (key.backspace || key.delete) { setQuery((q) => q.slice(0, -1)); setSelected(0); return; }
    if (key.upArrow) { setSelected(Math.max(0, index - 1)); return; }
    if (key.downArrow) { setSelected(index + 1); return; }
    if (key.return && current) {
      setActive((prev) => {
        const next = new Set(prev);
        if (next.has(current.name)) {
          next.delete(current.name);
        } else {
          next.add(current.name);
        }
        return next;
      });
      return;
    }
    if (input && input.length >= 1 && !key.ctrl && !key.meta) {
      setQuery((q) => q + input);
      setSelected(0);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Skills</Text>
      <Text dimColor>project: .agentforge/skills · global: {join(globalConfigDir(), 'skills')}</Text>
      <Text dimColor>type to filter · enter toggle active · Esc back</Text>
      <Text>Filter: {query || '(none)'}▏</Text>
      <Box flexDirection="column" marginTop={1}>
        {skills === null
          ? <Text dimColor>Loading skills…</Text>
          : filtered.length === 0
            ? <Text dimColor>{'(no skills found — add markdown files under .agentforge/skills/ or ' + join(globalConfigDir(), 'skills') + ')'}</Text>
            : filtered.map((skill, i) => (
                <Text key={`${skill.scope}:${skill.name}`} color={i === index ? 'cyan' : undefined}>
                  {i === index ? '❯ ' : '  '}
                  [{active.has(skill.name) ? 'x' : ' '}] {skill.name}
                  <Text dimColor> [{skill.scope}]</Text>
                  {skill.description ? <Text dimColor> — {skill.description}</Text> : null}
                </Text>
              ))}
      </Box>
      {current ? (
        <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
          <Text bold>{current.name} <Text dimColor>({current.scope})</Text></Text>
          {current.description ? <Text>{current.description}</Text> : null}
          {bodyPreview(current.body).map((line, i) => <Text key={i} dimColor>{line}</Text>)}
          <Text color={active.has(current.name) ? 'green' : 'gray'}>
            {active.has(current.name)
              ? `skill ${current.name} active`
              : `skill ${current.name} inactive`}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
