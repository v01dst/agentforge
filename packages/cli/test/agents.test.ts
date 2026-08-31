import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILTIN_AGENTS,
  extractAgentMentions,
  getAgentSync,
  listAgentsSync,
  renderAgentIndex,
} from '../src/agents/agents.js';
import { createTaskTool, subagentToolNames } from '../src/agents/task-tool.js';
import { createCodingTools } from '../src/coding-tools.js';

const context = { runId: 'test', signal: new AbortController().signal } as never;

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'af-agents-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function seedAgents(root: string): Promise<void> {
  await mkdir(join(root, '.agentforge', 'agents', 'reviewer'), { recursive: true });
  await writeFile(
    join(root, '.agentforge', 'agents', 'reviewer', 'AGENT.md'),
    ['---', 'name: reviewer', 'mode: subagent', 'description: Reviews diffs for hazards', 'permission: read-only', 'steps: 5', 'temperature: 0.2', '---', '', 'Review the provided diff.'].join('\n'),
    'utf8',
  );
  await writeFile(
    join(root, '.agentforge', 'agents', 'planner.md'),
    ['---', 'mode: primary', 'description: Planning agent', '---', '', 'Plan before acting.'].join('\n'),
    'utf8',
  );
}

test('markdown agents are discovered in both layouts; built-ins included', async () => {
  await withTemp(async (root) => {
    await seedAgents(root);
    const agents = listAgentsSync(root);
    const names = agents.map((agent) => agent.name).sort();
    assert.ok(names.includes('reviewer'), 'folder agent found');
    assert.ok(names.includes('planner'), 'flat agent found');
    for (const builtin of BUILTIN_AGENTS) assert.ok(names.includes(builtin.name), `${builtin.name} built-in present`);
  });
});

test('frontmatter fields are parsed and the body is the prompt', async () => {
  await withTemp(async (root) => {
    await seedAgents(root);
    const reviewer = getAgentSync('reviewer', root)!;
    assert.equal(reviewer.mode, 'subagent');
    assert.equal(reviewer.description, 'Reviews diffs for hazards');
    assert.equal(reviewer.permission, 'read-only');
    assert.equal(reviewer.steps, 5);
    assert.equal(reviewer.temperature, 0.2);
    assert.equal(reviewer.source, 'project');
    assert.match(reviewer.body, /Review the provided diff\./);
    const planner = getAgentSync('planner', root)!;
    assert.equal(planner.mode, 'primary');
  });
});

test('project agents shadow globals and built-ins by name', async () => {
  await withTemp(async (root) => {
    await mkdir(join(root, '.agentforge', 'agents'), { recursive: true });
    await writeFile(
      join(root, '.agentforge', 'agents', 'explore.md'),
      ['---', 'description: custom explorer', '---', '', 'Custom explore body.'].join('\n'),
      'utf8',
    );
    const explore = getAgentSync('explore', root)!;
    assert.equal(explore.source, 'project');
    assert.equal(explore.description, 'custom explorer');
    assert.match(explore.body, /Custom explore body\./);
  });
});

test('renderAgentIndex lists subagents but not primary agents', async () => {
  await withTemp(async (root) => {
    await seedAgents(root);
    const index = renderAgentIndex(listAgentsSync(root));
    assert.match(index, /- explore:/);
    assert.match(index, /- reviewer:/);
    assert.match(index, /\[read-only\]/);
    assert.ok(!index.includes('planner'), 'primary agents are not subagent-delegable');
  });
});

test('extractAgentMentions returns known names only, deduped', () => {
  const known = ['explore', 'general', 'reviewer'];
  assert.deepEqual(extractAgentMentions('hey @explore what uses foo?', known), ['explore']);
  assert.deepEqual(extractAgentMentions('@explore and @explore and @reviewer', known), ['explore', 'reviewer']);
  assert.deepEqual(extractAgentMentions('email me at bob@example.com', known), []);
  assert.deepEqual(extractAgentMentions('no mentions here', known), []);
  assert.deepEqual(extractAgentMentions('@unknown-agent', known), []);
});

test('subagentToolNames: read-only excludes write tools; trusted includes commands', () => {
  const readOnly = subagentToolNames('read-only');
  assert.ok(readOnly.includes('read_file'));
  assert.ok(!readOnly.includes('apply_patch'));
  assert.ok(!readOnly.includes('run_command'));
  const trusted = subagentToolNames('trusted');
  assert.ok(trusted.includes('run_command'));
  assert.ok(trusted.includes('apply_patch'));
});

test('task tool: unknown agent and primary-agent rejections', async () => {
  await withTemp(async (root) => {
    await seedAgents(root);
    const tool = createTaskTool({ root }, root);
    const unknown = await tool.execute({ agent: 'nonexistent', prompt: 'x' }, context);
    assert.equal(unknown.ok, false);
    assert.match((unknown as { error: string }).error, /Unknown subagent/);
    const primary = await tool.execute({ agent: 'planner', prompt: 'x' }, context);
    assert.equal(primary.ok, false);
    assert.match((primary as { error: string }).error, /primary agent/);
  });
});

test('task tool runs a subagent with a mock model and posture-filtered tools', async () => {
  await withTemp(async (root) => {
    await seedAgents(root);
    const calls: string[] = [];
    const mockModel = {
      provider: 'mock',
      model: 'mock-1',
      async generate() {
        calls.push('generate');
        return { id: 'm1', content: 'subagent final report' };
      },
    };
    const tool = createTaskTool({ root, modelInstance: mockModel }, root);
    const result = await tool.execute({ agent: 'reviewer', prompt: 'review src/app.ts' }, context) as { ok: boolean; output?: string };
    assert.equal(result.ok, true);
    assert.equal(result.output, 'subagent final report');
    assert.equal(calls.length, 1);
  });
});

test('createCodingTools registers task by default and honors disableSubagents', async () => {
  await withTemp(async (root) => {
    const withTask = createCodingTools({ root });
    assert.ok(withTask.some((tool) => tool.name === 'task'), 'task tool present by default');
    const without = createCodingTools({ root, disableSubagents: true });
    assert.ok(!without.some((tool) => tool.name === 'task'), 'task tool omitted when disabled');
  });
});
