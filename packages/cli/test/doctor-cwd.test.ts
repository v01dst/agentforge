import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctorCommand } from '../src/commands.js';
import { execute } from '../src/cli.js';

/** Capture stdout while an async operation runs. */
async function captureStdout(operation: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    chunks.push(chunk);
    return true;
  };
  try {
    await operation();
  } finally {
    (process.stdout as unknown as { write: (chunk: string) => boolean }).write = original;
  }
  return chunks.join('');
}

async function makeProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'af-doctor-'));
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  return dir;
}

test('doctor passes on a valid project and reports the resolved entrypoint', async () => {
  const project = await makeProject({
    'agentforge.config.mjs': "export default { name: 'doctor-ok', entry: 'src/agent.ts', providers: ['mock'] };\n",
    'src/agent.ts': 'export const config = {};\n',
  });
  const previousCwd = process.cwd();
  process.chdir(project);
  try {
    const output = await captureStdout(() => doctorCommand({ json: true }));
    const report = JSON.parse(output) as { checks: Array<{ name: string; ok: boolean; detail: string }> };
    const configuration = report.checks.find((check) => check.name === 'Configuration');
    const entrypoint = report.checks.find((check) => check.name === 'Entrypoint');
    assert.equal(configuration?.ok, true);
    assert.equal(entrypoint?.ok, true);
    assert.match(entrypoint?.detail ?? '', /src\/agent\.ts/);
    const exit = await doctorCommand({ json: true });
    assert.equal(exit, 0);
  } finally {
    process.chdir(previousCwd);
    await rm(project, { recursive: true, force: true });
  }
});

test('doctor fails with a resolved-path detail when the entrypoint is missing', async () => {
  const project = await makeProject({
    'agentforge.config.mjs': "export default { name: 'doctor-bad', entry: 'src/gone.ts', providers: ['mock'] };\n",
  });
  const previousCwd = process.cwd();
  process.chdir(project);
  try {
    const output = await captureStdout(async () => {
      const exit = await doctorCommand({ json: true });
      assert.equal(exit, 1);
    });
    const report = JSON.parse(output) as { checks: Array<{ name: string; ok: boolean; detail: string }> };
    const entrypoint = report.checks.find((check) => check.name === 'Entrypoint');
    assert.equal(entrypoint?.ok, false);
    assert.match(entrypoint?.detail ?? '', /missing: src\/gone\.ts/);
  } finally {
    process.chdir(previousCwd);
    await rm(project, { recursive: true, force: true });
  }
});

test('--cwd targets a project from a different working directory', async () => {
  const project = await makeProject({
    'agentforge.config.mjs': "export default { name: 'cwd-check', entry: 'src/agent.ts', providers: ['mock'] };\n",
    'src/agent.ts': 'export const config = {};\n',
  });
  try {
    const output = await captureStdout(() => execute(['--cwd', project, 'doctor', '--json']));
    const report = JSON.parse(output) as { checks: Array<{ name: string; ok: boolean; detail: string }> };
    const configuration = report.checks.find((check) => check.name === 'Configuration');
    assert.equal(configuration?.ok, true);
    assert.match(configuration?.detail ?? '', /agentforge\.config\.mjs/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('--cwd run uses config-relative entry discovery from outside the project', async () => {
  const project = await makeProject({
    'agentforge.config.mjs': "export default { name: 'cwd-run', entry: 'src/agent.ts', providers: ['mock'] };\n",
    'src/agent.ts': 'export default {};\n',
  });
  try {
    // The entrypoint exists, so runCommand should reach the model stage (not
    // fail with "Entrypoint not found"). A minimal entry without exports still
    // exercises config-relative discovery; assert the NOT-found error is absent.
    let failure: string | undefined;
    try {
      await execute(['--cwd', project, 'run', '--input', 'hello']);
    } catch (error) {
      failure = (error as Error).message;
    }
    assert.ok(!failure?.includes('Entrypoint not found'), failure ?? 'no entrypoint error');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
