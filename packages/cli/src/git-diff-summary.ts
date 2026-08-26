import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** One-line `git diff --stat` tail, or undefined outside a git work tree. */
export async function gitDiffSummary(cwd = process.cwd()): Promise<string | undefined> {
  try {
    await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
    const { stdout } = await run('git', ['diff', '--stat', '--no-color'], { cwd, maxBuffer: 1024 * 1024 });
    const lines = stdout.trim().split('\n').filter(Boolean);
    return lines.filter((line) => line.includes('|')).at(-1) ?? lines.at(-1);
  } catch {
    return undefined;
  }
}
