import { chmod, mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Credentials store (0.8): API keys entered inside the CLI land in
 * `~/.agentforge/credentials.json` (chmod 600, home directory only — never
 * inside a project). Resolution order for any key: environment variable
 * first, then this file. Values are stored per provider entry name AND per
 * env-var name so both lookup styles work:
 *
 *   { "entries": { "openrouter": "sk-or-…" }, "envs": { "OPENROUTER_API_KEY": "sk-or-…" } }
 *
 * Doctrine change, documented in the CHANGELOG: this replaces "keys never
 * touch disk" with "keys live in one 0600 file in the user's home".
 */

export interface CredentialsFile {
  /** Provider entry name → key. */
  entries: Record<string, string>;
  /** Env var name → key. */
  envs: Record<string, string>;
}

export function credentialsPath(home = homedir()): string {
  return join(home, '.agentforge', 'credentials.json');
}

function emptyFile(): CredentialsFile {
  return { entries: {}, envs: {} };
}

export async function readCredentials(home = homedir()): Promise<CredentialsFile> {
  try {
    const parsed = JSON.parse(await readFile(credentialsPath(home), 'utf8')) as Partial<CredentialsFile>;
    return {
      entries: typeof parsed.entries === 'object' && parsed.entries !== null ? parsed.entries : {},
      envs: typeof parsed.envs === 'object' && parsed.envs !== null ? parsed.envs : {},
    };
  } catch {
    return emptyFile();
  }
}

export async function saveCredential(options: { entry?: string; env?: string; key: string }, home = homedir()): Promise<string> {
  if (!options.entry && !options.env) throw new Error('saveCredential needs an entry name and/or an env var name.');
  const file = await readCredentials(home);
  if (options.entry) file.entries[options.entry] = options.key;
  if (options.env) file.envs[options.env] = options.key;
  const path = credentialsPath(home);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  await chmod(path, 0o600);
  return path;
}

export async function deleteCredential(options: { entry?: string; env?: string }, home = homedir()): Promise<boolean> {
  const file = await readCredentials(home);
  let changed = false;
  if (options.entry && file.entries[options.entry] !== undefined) { delete file.entries[options.entry]; changed = true; }
  if (options.env && file.envs[options.env] !== undefined) { delete file.envs[options.env]; changed = true; }
  if (!changed) return false;
  const path = credentialsPath(home);
  if (!Object.keys(file.entries).length && !Object.keys(file.envs).length) {
    await unlink(path).catch(() => {});
    return true;
  }
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  await chmod(path, 0o600);
  return true;
}

/**
 * Resolve the key for an env var: environment first, credentials file
 * second. Returns undefined when nothing is stored (never a fake).
 */
export async function resolveCredential(envName: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<string | undefined> {
  if (env[envName]) return env[envName];
  const file = await readCredentials(home);
  return file.envs[envName];
}

/**
 * Session-scoped injection: copy stored credentials into process.env so the
 * provider adapters (which read env vars) pick them up without changing any
 * adapter code. Never overwrites a real environment value.
 */
export async function injectCredentialsIntoEnv(env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<number> {
  const file = await readCredentials(home);
  let injected = 0;
  for (const [envName, key] of Object.entries(file.envs)) {
    if (!env[envName] && key) { env[envName] = key; injected += 1; }
  }
  return injected;
}
