import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { listSkills, type SkillInfo } from '../../skills/skills.js';

function bodyPreview(body: string | undefined): string[] {
  if (!body) return [];
  return body.split(/\r?\n/).slice(0, 20);
}

export function SkillsScreen({ onBack }: { onBack?: () => void }): React.ReactElement {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [active, setActive] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    void listSkills()
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
      <Text dimColor>type to filter · enter toggle active · Esc back</Text>
      <Text>Filter: {query || '(none)'}▏</Text>
      <Box flexDirection="column" marginTop={1}>
        {skills === null
          ? <Text dimColor>Loading skills…</Text>
          : filtered.length === 0
            ? <Text dimColor>(no skills found — add markdown files under .agentforge/skills/)</Text>
            : filtered.map((skill, i) => (
                <Text key={skill.name} color={i === index ? 'cyan' : undefined}>
                  {i === index ? '❯ ' : '  '}
                  [{active.has(skill.name) ? 'x' : ' '}] {skill.name}
                  {skill.description ? <Text dimColor> — {skill.description}</Text> : null}
                </Text>
              ))}
      </Box>
      {current ? (
        <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
          <Text bold>{current.name}</Text>
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
