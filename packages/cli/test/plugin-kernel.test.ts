import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectPlugins, pluginContributions, disabledPluginKeys } from '../src/plugins/plugins.js';
import { readExtensions, writeExtensions } from '../src/extensions/store.js';
import { buildAgentRunner } from '../src/coding-session.js';

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'af-plugin-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const hookPluginSource = `
const plugin = {
  name: 'annotator',
  description: 'Annotates every turn and observes tools',
  hooks: {
    preStep: [async ({ input }) => input + ' [annotated]'],
    turnStopping: [async ({ output }) => '[reviewed] ' + output],
    preTool: [async (call) => call.name === 'forbidden' ? 'not allowed by plugin' : undefined],
  },
  slashCommands: [{ name: 'plug', description: 'Plugin command', run: () => {} }],
  skills: [{ name: 'plug-skill', body: 'Always double-check imports.' }],
  agents: ['---\\ndescription: helper agent\\nmode: subagent\\n---\\nYou are a helper.'],
};
export default plugin;
`;

test('plugin v2 contributions load with kinds surfaced', async () => {
  await withTemp(async (root) => {
    await mkdir(join(root, '.agentforge'), { recursive: true });
    await mkdir(join(root, 'plugins'), { recursive: true });
    await writeFile(join(root, 'plugins', 'annotator.ts'), hookPluginSource, 'utf8');
    await writeExtensions({ plugins: ['./plugins/annotator.ts'] }, root);
    const extensions = await readExtensions(root);
    const { plugins, failures } = await loadProjectPlugins(extensions, root);
    assert.deepEqual(failures, []);
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0]!.name, 'annotator');
    assert.deepEqual([...plugins[0]!.contributions].sort(), ['agents', 'hooks', 'skills', 'slash-commands']);
    assert.equal(plugins[0]!.slashCommands[0], 'plug');
    assert.equal(plugins[0]!.skills[0], 'plug-skill');
  });
});

test('plugin hooks flow into the core interceptor seam', async () => {
  await withTemp(async (root) => {
    await mkdir(join(root, '.agentforge'), { recursive: true });
    await mkdir(join(root, 'plugins'), { recursive: true });
    await writeFile(join(root, 'plugins', 'annotator.ts'), hookPluginSource, 'utf8');
    await writeExtensions({ plugins: ['./plugins/annotator.ts'] }, root);
    const { hooks } = await pluginContributions(await readExtensions(root), root);
    assert.equal(hooks.preStep?.length, 1);
    assert.equal(hooks.turnStopping?.length, 1);
    assert.equal(hooks.preTool?.length, 1);
    const fakeModel = { generate: async (request: { messages: Array<{ role: string; content: string }> }) => {
      const captured = request.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
      return { id: 'x', content: captured.replace(/.*hello/, 'done'), finishReason: 'stop' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    } };
    const runner = buildAgentRunner({ root, pluginHooks: hooks, modelInstance: fakeModel });
    let finalText = '';
    for await (const delta of runner('hello')) {
      if (delta.text) finalText += delta.text;
    }
    assert.match(finalText, /\[reviewed\]/);
  });
});

test('disabled plugins stay registered but never load', async () => {
  await withTemp(async (root) => {
    await mkdir(join(root, '.agentforge'), { recursive: true });
    await mkdir(join(root, 'plugins'), { recursive: true });
    await writeFile(join(root, 'plugins', 'annotator.ts'), hookPluginSource, 'utf8');
    await writeExtensions({ plugins: [{ path: './plugins/annotator.ts', disabled: true }] }, root);
    const extensions = await readExtensions(root);
    assert.equal(disabledPluginKeys(extensions).size, 1);
    const { plugins } = await loadProjectPlugins(extensions, root);
    assert.deepEqual(plugins, []);
    const contributions = await pluginContributions(extensions, root);
    assert.deepEqual(contributions.tools, []);
    assert.equal(contributions.hooks.preStep, undefined);
  });
});

test('invalid plugin contracts fail loudly per path', async () => {
  await withTemp(async (root) => {
    await mkdir(join(root, 'plugins'), { recursive: true });
    await writeFile(join(root, 'plugins', 'bad.ts'), 'export default { name: "bad", tools: "nope" };', 'utf8');
    const { failures } = await loadProjectPlugins({ plugins: ['./plugins/bad.ts'] }, root);
    assert.equal(failures.length, 1);
    assert.match(failures[0]!.reason, /must be an array/);
  });
});
