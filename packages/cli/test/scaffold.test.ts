import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scaffold } from '../src/project.js';

async function tempProject(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'agentforge-scaffold-'));
}

test('scaffold creates a complete pnpm-based local-link project', async () => {
  const workspace = await tempProject();
  try {
    const target = await scaffold('demo-agent', workspace, false, '/opt/agentforge');
    for (const relative of ['.gitignore', '.env.example', 'package.json', 'agentforge.config.ts', 'tsconfig.json', 'src/agent.ts', 'test/agent.test.ts', 'README.md', 'provider.example.mjs']) {
      await readFile(join(target, relative), 'utf8');
    }
    const packageJson = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      pnpm?: { overrides?: Record<string, string> };
    };
    assert.equal(packageJson.dependencies?.['@agentforge-oss/core'], 'file:/opt/agentforge/packages/core');
    assert.equal(packageJson.dependencies?.['@agentforge-oss/cli'], 'file:/opt/agentforge/packages/cli');
    assert.equal(packageJson.dependencies?.['@agentforge-oss/models'], 'file:/opt/agentforge/packages/models');
    assert.equal(packageJson.pnpm?.overrides?.['@agentforge-oss/core'], 'file:/opt/agentforge/packages/core');
    for (const script of ['chat', 'run', 'typecheck', 'test']) assert.ok(packageJson.scripts?.[script], `script ${script} exists`);
    const readme = await readFile(join(target, 'README.md'), 'utf8');
    assert.match(readme, /^\s*pnpm install$/m);
    assert.match(readme, /pnpm exec agentforge chat/);
    assert.doesNotMatch(readme, /^\s*npm install/m);
    assert.doesNotMatch(readme, /\bnpx /);
    const envExample = await readFile(join(target, '.env.example'), 'utf8');
    assert.match(envExample, /OPENAI_API_KEY=/);
    assert.doesNotMatch(envExample, /=\s*sk-/);
    const agentSource = await readFile(join(target, 'src/agent.ts'), 'utf8');
    assert.match(agentSource, /export function createSession/);
    assert.match(agentSource, /createAgent/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('scaffold refuses invalid project names and existing files', async () => {
  const workspace = await tempProject();
  try {
    await assert.rejects(() => scaffold('1bad-name', workspace), /must start with a letter/);
    await scaffold('twice', workspace);
    await assert.rejects(() => scaffold('twice', workspace), /Refusing to overwrite/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
