import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from '../src/cli.js';
import { runCommand } from '../src/commands.js';
import { scaffold } from '../src/project.js';

test('parses command, positional arguments, and long flags', () => {
  const parsed = parseArgs(['run', 'src/agent.ts', '--input', 'hello world', '--json']);
  assert.equal(parsed.command, 'run');
  assert.deepEqual(parsed.args, ['src/agent.ts']);
  assert.equal(parsed.flags.input, 'hello world');
  assert.equal(parsed.flags.json, true);
});

test('supports short help and passthrough arguments', () => {
  const parsed = parseArgs(['test', '--', '--watch']);
  assert.equal(parsed.command, 'test');
  assert.deepEqual(parsed.args, ['--watch']);
});

test('local-link scaffold prints pnpm instructions and file dependencies', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agentforge-scaffold-'));
  try {
    const target = await scaffold('linked-agent', parent, false, join(parent, 'agentforge-repo'));
    const packageJson = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    assert.equal(packageJson.dependencies?.['@agentforge-oss/core'], `file:${resolve(parent, 'agentforge-repo', 'packages', 'core')}`);
    assert.equal(packageJson.dependencies?.['@agentforge-oss/cli'], `file:${resolve(parent, 'agentforge-repo', 'packages', 'cli')}`);
    assert.equal(packageJson.dependencies?.['@agentforge-oss/models'], `file:${resolve(parent, 'agentforge-repo', 'packages', 'models')}`);
    const readme = await readFile(join(target, 'README.md'), 'utf8');
    assert.match(readme, /pnpm install/);
    assert.match(readme, /pnpm exec agentforge chat/);
    assert.match(readme, /Local-link mode/);
    const examplePlugin = await readFile(join(target, 'plugins', 'example.ts'), 'utf8');
    assert.match(examplePlugin, /AgentForgePlugin/);
    const extensionsJson = JSON.parse(await readFile(join(target, '.agentforge', 'extensions.json'), 'utf8')) as { plugins?: string[] };
    assert.deepEqual(extensionsJson.plugins, ['./plugins/example.ts']);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('published-mode scaffold keeps registry instructions', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agentforge-scaffold-'));
  try {
    const target = await scaffold('registry-agent', parent);
    const packageJson = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    assert.equal(packageJson.dependencies?.['@agentforge-oss/core'], '^0.6.0');
    const readme = await readFile(join(target, 'README.md'), 'utf8');
    assert.match(readme, /npm install/);
    assert.match(readme, /npx agentforge chat/);
    assert.doesNotMatch(readme, /pnpm install/);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('scaffold accepts "." and derives the project name from the directory', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agentforge-initdot-'));
  try {
    const target = await scaffold('.', parent);
    assert.equal(target, resolve(parent));
    const packageJson = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) as { name?: string };
    const expected = parent.split(/[\\/]/).pop() as string;
    assert.equal(packageJson.name, expected);
    assert.ok(expected.length >= 1 && /^[a-zA-Z]/.test(expected), `derived name must be valid: ${expected}`);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('missing entrypoint error reports resolved path, config path, and guidance', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agentforge-entry-'));
  await writeFile(join(project, 'agentforge.config.mjs'), "export default { name: 'entry-check', entry: 'src/agent.ts' };\n");
  const previousCwd = process.cwd();
  process.chdir(project);
  try {
    await assert.rejects(
      () => runCommand(undefined, { input: 'hello' }),
      (error: Error) => {
        assert.match(error.message, /Entrypoint not found: src\/agent\.ts/);
        assert.ok(error.message.includes(`resolved: ${resolve(project, 'src/agent.ts')}`), error.message);
        assert.ok(error.message.includes(`config:   ${join(project, 'agentforge.config.mjs')}`), error.message);
        return true;
      },
    );
  } finally {
    process.chdir(previousCwd);
    await rm(project, { recursive: true, force: true });
  }
});

test('missing entrypoint without config suggests scaffolding', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'agentforge-empty-'));
  const previousCwd = process.cwd();
  process.chdir(empty);
  try {
    await assert.rejects(
      () => runCommand('does-not-exist.ts', { input: 'hello' }),
      (error: Error) => {
        assert.match(error.message, /Entrypoint not found: does-not-exist\.ts/);
        assert.ok(error.message.includes(`resolved: ${resolve(empty, 'does-not-exist.ts')}`), error.message);
        assert.match(error.message, /No agentforge\.config\.ts was found/);
        return true;
      },
    );
  } finally {
    process.chdir(previousCwd);
    await rm(empty, { recursive: true, force: true });
  }
});
