import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectPlugins, pluginContributions, pluginPaths } from '../src/plugins/plugins.js';
import { writeExtensions, type ExtensionsFile } from '../src/extensions/store.js';

const delay = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentforge-plugins-'));
  await mkdir(join(dir, '.agentforge'), { recursive: true });
  return dir;
}

const goodPlugin = `export default {
  name: 'greeter',
  description: 'says hello',
  instructions: 'Be polite.',
  tools: [
    { name: 'greet', description: 'greet', inputSchema: { parse: (v) => v }, permissions: [], async execute(input) { return input; } },
  ],
};
`;

const brokenPlugin = `export default { nope: true };
`;

test('pluginPaths normalizes string and object entries', () => {
  const extensions: ExtensionsFile = { plugins: ['./a.ts', { name: 'b', path: '/abs/b.mjs' }] };
  const paths = pluginPaths(extensions, '/proj');
  assert.equal(paths.length, 2);
  assert.match(paths[0] as string, /[/\\]proj[/\\]a\.ts$/);
  assert.equal(paths[1], '/abs/b.mjs');
});

test('loadProjectPlugins reports healthy plugins and per-path failures', async () => {
  const project = await makeProject();
  try {
    await writeFile(join(project, 'good.mjs'), goodPlugin);
    await writeFile(join(project, 'broken.mjs'), brokenPlugin);
    await writeFile(join(project, 'missing-registered.mjs'), '');
    const extensions: ExtensionsFile = { plugins: ['./good.mjs', './broken.mjs', './does-not-exist.mjs'] };
    const { plugins, failures } = await loadProjectPlugins(extensions, project);
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0]?.name, 'greeter');
    assert.deepEqual(plugins[0]?.tools, ['greet']);
    assert.equal(plugins[0]?.hasInstructions, true);
    assert.equal(failures.length, 2);
    assert.ok(failures.some((failure) => failure.path.endsWith('broken.mjs')));
    assert.ok(failures.some((failure) => failure.path.endsWith('does-not-exist.mjs')));
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('pluginContributions flattens tools and instructions from healthy plugins only', async () => {
  const project = await makeProject();
  try {
    await writeFile(join(project, 'good.mjs'), goodPlugin);
    await writeFile(join(project, 'broken.mjs'), brokenPlugin);
    await delay(10);
    const { tools, instructions } = await pluginContributions({ plugins: ['./good.mjs', './broken.mjs'] }, project);
    assert.equal(tools.length, 1);
    assert.deepEqual(instructions, ['Be polite.']);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('plugins add/remove round-trips through extensions.json via commands layer store', async () => {
  const project = await makeProject();
  try {
    await writeFile(join(project, 'p.mjs'), goodPlugin);
    await writeExtensions({ plugins: [] }, project);
    const before = await loadProjectPlugins(undefined, project);
    assert.equal(before.plugins.length, 0);
    await writeExtensions({ plugins: [join(project, 'p.mjs')] }, project);
    const after = await loadProjectPlugins(undefined, project);
    assert.equal(after.plugins.length, 1);
    assert.equal(after.failures.length, 0);
  } finally { await rm(project, { recursive: true, force: true }); }
});
