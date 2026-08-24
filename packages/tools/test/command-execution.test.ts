import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandBlockedError, createRunCommandTool, createRunTestsTool } from '../src/command-execution.js';

const context = { runId: 'test', signal: new AbortController().signal } as never;

async function makeTempProject(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cmdexec-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, 'utf8');
  }
  return dir;
}

describe('run_command', () => {
  it('rejects commands that are not allowlisted', async () => {
    const root = await makeTempProject();
    const tool = createRunCommandTool({ root, allowedCommands: ['echo'] });
    await assert.rejects(() => tool.execute({ command: 'cat', args: ['/etc/hostname'] }, context), CommandBlockedError);
  });

  it('rejects arguments containing shell metacharacters', async () => {
    const root = await makeTempProject();
    const tool = createRunCommandTool({ root, allowedCommands: ['echo'] });
    for (const bad of ['a;b', 'a&&b', 'a|b', 'a`b', 'a$(b)', 'a>b', 'a<b']) {
      await assert.rejects(() => tool.execute({ command: 'echo', args: [bad] }, context), CommandBlockedError, `expected rejection for ${bad}`);
    }
  });

  it('rejects command lines matching default blocked patterns', async () => {
    const root = await makeTempProject();
    const tool = createRunCommandTool({ root, allowedCommands: ['rm', 'sudo'] });
    await assert.rejects(() => tool.execute({ command: 'rm', args: ['-rf', '/'] }, context), CommandBlockedError);
    await assert.rejects(() => tool.execute({ command: 'sudo', args: ['ls'] }, context), CommandBlockedError);
  });

  it('supports custom blocked patterns', async () => {
    const root = await makeTempProject();
    const tool = createRunCommandTool({ root, allowedCommands: ['node'], blockedPatterns: [/forbidden-thing/] });
    await assert.rejects(() => tool.execute({ command: 'node', args: ['-e', 'x', 'forbidden-thing'] }, context), CommandBlockedError);
  });

  it('captures stdout of a successful command with durationMs', async () => {
    const root = await makeTempProject();
    const tool = createRunCommandTool({ root, allowedCommands: ['echo'] });
    const result = (await tool.execute({ command: 'echo', args: ['hello-world'] }, context)) as { stdout: string; exitCode: number; command: string; durationMs: number };
    assert.equal(result.stdout.trim(), 'hello-world');
    assert.equal(result.exitCode, 0);
    assert.equal(result.command, 'echo');
    assert.ok(result.durationMs >= 0);
  });

  it('returns non-zero exit codes instead of throwing', async () => {
    const root = await makeTempProject();
    const tool = createRunCommandTool({ root, allowedCommands: ['false'] });
    const result = (await tool.execute({ command: 'false' }, context)) as { exitCode: number; stdout: string };
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
  });

  it('runs inside the configured workspace root', async () => {
    const root = await makeTempProject({ 'marker.txt': 'present' });
    const tool = createRunCommandTool({ root, allowedCommands: ['cat'] });
    const result = (await tool.execute({ command: 'cat', args: ['marker.txt'] }, context)) as { stdout: string };
    assert.equal(result.stdout, 'present');
  });
});

describe('run_tests', () => {
  const passingScript = ['#!/bin/sh', 'echo "all tests passed"', 'exit 0'].join('\n');
  const failingScript = ['#!/bin/sh', 'echo "tests failed" >&2', 'exit 1'].join('\n');

  it('uses the explicit test command and appends pattern as trailing arg', async () => {
    const projectRoot = await makeTempProject({
      'package.json': JSON.stringify({ name: 'tiny-project', version: '1.0.0', scripts: {} }),
    });
    const scriptPath = join(projectRoot, 'pass.sh');
    await writeFile(scriptPath, passingScript, { mode: 0o755 });
    const tool = createRunTestsTool({ root: projectRoot, testCommand: { command: scriptPath, args: [] } });
    const result = (await tool.execute({ pattern: 'extra-pattern' }, context)) as { command: string; args: string[]; exitCode: number; passed: boolean; stdout: string };
    assert.equal(result.command, scriptPath);
    assert.deepEqual(result.args, ['extra-pattern']);
    assert.equal(result.exitCode, 0);
    assert.equal(result.passed, true);
    assert.ok(result.stdout.includes('all tests passed'));
  });

  it('reports failures via passed=false without throwing', async () => {
    const projectRoot = await makeTempProject({});
    const scriptPath = join(projectRoot, 'fail.sh');
    await writeFile(scriptPath, failingScript, { mode: 0o755 });
    const tool = createRunTestsTool({ root: projectRoot, testCommand: { command: scriptPath, args: [] } });
    const result = (await tool.execute({}, context)) as { passed: boolean; exitCode: number; stderr: string };
    assert.equal(result.passed, false);
    assert.equal(result.exitCode, 1);
    assert.ok(result.stderr.includes('tests failed'));
  });

  it('discovers a package.json test script when no explicit command is given', async () => {
    const runner = ["const fs = require('node:fs');", 'console.log("all tests passed");', 'process.exit(0);'].join('\n');
    const dir = await makeTempProject({
      'package.json': JSON.stringify({ scripts: { test: 'node runner.cjs --quiet' } }),
      'runner.cjs': runner,
    });
    const tool = createRunTestsTool({ root: dir });
    const result = (await tool.execute({}, context)) as { command: string; args: string[]; passed: boolean };
    assert.equal(result.command, 'node');
    assert.deepEqual(result.args, ['runner.cjs', '--quiet']);
    assert.equal(result.passed, true);
  });
});
