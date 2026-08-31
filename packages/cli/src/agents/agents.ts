import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseFrontmatter } from '../skills/skills.js';

/**
 * Markdown agent definitions (Phase F): `.agentforge/agents/<name>.md` (flat)
 * or `.agentforge/agents/<name>/AGENT.md` (folder), with a global fallback at
 * `~/.agentforge/agents/`. Project files shadow global ones by name, and
 * user-defined files shadow the built-in subagents. Frontmatter is parsed with
 * the same `key: value` parser used by skills; the body is the agent prompt.
 */

export type AgentMode = 'primary' | 'subagent';

/** Posture name shared with the permission layer; filters the subagent toolset. */
export type AgentPermission = 'read-only' | 'workspace-write' | 'trusted';

export interface AgentInfo {
  name: string;
  mode: AgentMode;
  description?: string;
  model?: string;
  temperature?: number;
  steps?: number;
  permission?: AgentPermission;
  /** The markdown body — the agent's prompt. */
  body: string;
  /** Where this agent was found. */
  source: 'project' | 'global' | 'builtin';
}

const AGENTS_DIR = '.agentforge/agents';
const AGENT_FILE = 'AGENT.md';

export const BUILTIN_AGENTS: readonly AgentInfo[] = [
  {
    name: 'explore',
    mode: 'subagent',
    description: 'Fast read-only codebase explorer. Finds files, answers questions about structure and code, never edits.',
    permission: 'read-only',
    steps: 8,
    body: [
      'You are explore, a read-only codebase explorer subagent.',
      'Inspect the repository with list_files, read_file, and search_text.',
      'Answer the delegated question directly with concrete file paths and line references.',
      'You cannot edit files — report what you found instead of attempting changes.',
    ].join('\n'),
    source: 'builtin',
  },
  {
    name: 'general',
    mode: 'subagent',
    description: 'General-purpose subagent for multi-step tasks that should not pollute the main conversation.',
    permission: 'workspace-write',
    steps: 12,
    body: [
      'You are general, a general-purpose coding subagent.',
      'Complete the delegated task end to end using the repository tools.',
      'Stay within the task you were given; be concise in your final report.',
    ].join('\n'),
    source: 'builtin',
  },
];

export function agentsDir(cwd = process.cwd(), global = false): string {
  return global
    ? join(homedir(), '.agentforge', 'agents')
    : join(resolve(cwd), AGENTS_DIR);
}

function normalizeMode(value: string | undefined): AgentMode {
  return value === 'primary' ? 'primary' : 'subagent';
}

function normalizePermission(value: string | undefined): AgentPermission | undefined {
  return value === 'read-only' || value === 'workspace-write' || value === 'trusted' ? value : undefined;
}

function agentFromMarkdown(name: string, raw: string, source: AgentInfo['source']): AgentInfo {
  const { data, body } = parseFrontmatter(raw);
  const temperature = data.temperature !== undefined && data.temperature !== '' && !Number.isNaN(Number(data.temperature))
    ? Number(data.temperature)
    : undefined;
  const steps = data.steps !== undefined && data.steps !== '' && !Number.isNaN(Number(data.steps))
    ? Number(data.steps)
    : undefined;
  return {
    name,
    mode: normalizeMode(data.mode),
    description: data.description || undefined,
    model: data.model || undefined,
    temperature,
    steps,
    permission: normalizePermission(data.permission),
    body,
    source,
  };
}

function readAgentsFromDir(dir: string, source: AgentInfo['source']): AgentInfo[] {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const agents: AgentInfo[] = [];
  for (const name of names) {
    if (name.startsWith('.') || name.startsWith('_')) continue;
    const entryPath = join(dir, name);
    try {
      const info = statSync(entryPath);
      if (info.isDirectory()) {
        agents.push(agentFromMarkdown(name, readFileSync(join(entryPath, AGENT_FILE), 'utf8'), source));
      } else if (name.endsWith('.md')) {
        agents.push(agentFromMarkdown(name.replace(/\.md$/, ''), readFileSync(entryPath, 'utf8'), source));
      }
    } catch {
      continue;
    }
  }
  return agents;
}

/**
 * Synchronous agent registry (session-store pattern): project agents shadow
 * global agents shadow built-ins, all matched by name. Includes built-in
 * `explore` and `general` unless user files redefine them.
 */
export function listAgentsSync(cwd = process.cwd()): AgentInfo[] {
  const merged = new Map<string, AgentInfo>();
  for (const agent of BUILTIN_AGENTS) merged.set(agent.name, agent);
  for (const agent of readAgentsFromDir(agentsDir(cwd, true), 'global')) merged.set(agent.name, agent);
  for (const agent of readAgentsFromDir(agentsDir(cwd), 'project')) merged.set(agent.name, agent);
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getAgentSync(name: string, cwd = process.cwd()): AgentInfo | undefined {
  return listAgentsSync(cwd).find((agent) => agent.name === name);
}

/** Compact index injected into the primary agent's instructions. */
export function renderAgentIndex(agents: readonly AgentInfo[]): string {
  const subagents = agents.filter((agent) => agent.mode === 'subagent');
  if (!subagents.length) return '';
  return [
    'Subagents you may delegate to through the `task` tool:',
    ...subagents.map((agent) => `- ${agent.name}: ${agent.description ?? '(no description)'}${agent.permission === 'read-only' ? ' [read-only]' : ''}`),
  ].join('\n');
}

/** @mention extraction: `@name` tokens matching known agent names. */
export function extractAgentMentions(input: string, knownNames: readonly string[]): string[] {
  const tokens = input.match(/@[\w-]+/g) ?? [];
  const known = new Set(knownNames);
  return [...new Set(tokens.map((token) => token.slice(1)).filter((name) => known.has(name)))];
}
