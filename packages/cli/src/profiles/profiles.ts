import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Profiles (Phase P): named bundles of session settings stored at
 * `~/.agentforge/profiles.json` (global) and `.agentforge/profiles.json`
 * (project). Project profiles shadow global ones by name. A profile pins
 * provider/model and optionally the permission posture, so a developer can
 * switch between e.g. `fast` (anthropic/haiku, read-only) and `deep`
 * (anthropic/sonnet, workspace-write) with one command instead of three.
 */

export interface Profile {
  name: string;
  provider?: string;
  model?: string;
  /** Permission posture applied when the profile activates (optional). */
  permissionMode?: 'read-only' | 'ask' | 'workspace-write' | 'trusted';
}

export interface ProfileFile {
  profiles: Profile[];
  /** Name of the last activated profile, for `agentforge profile current`. */
  active?: string;
}

export const PROFILES_FILE = 'profiles.json';

export function profilePaths(cwd = process.cwd()): { project: string; global: string } {
  return {
    project: join(resolve(cwd), '.agentforge', PROFILES_FILE),
    global: join(homedir(), '.agentforge', PROFILES_FILE),
  };
}

const PROFILE_SCHEMA = z.object({
  name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  provider: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(128).optional(),
  permissionMode: z.enum(['read-only', 'ask', 'workspace-write', 'trusted']).optional(),
});

function validateProfileFile(parsed: unknown, source: string): ProfileFile {
  if (parsed === null || parsed === undefined) return { profiles: [] };
  if (typeof parsed !== 'object' || !Array.isArray((parsed as { profiles?: unknown }).profiles)) {
    throw new Error(`${source} must contain a "profiles" array.`);
  }
  const profiles = (parsed as { profiles: unknown[] }).profiles.map((entry, index) => {
    const result = PROFILE_SCHEMA.safeParse(entry);
    if (!result.success) {
      const name = (entry as { name?: unknown })?.name;
      throw new Error(`${source}: invalid profile at index ${index}${name ? ` (${String(name)})` : ''}: ${result.error.issues[0]?.message ?? 'malformed'}`);
    }
    return result.data as Profile;
  });
  const active = (parsed as { active?: unknown }).active;
  return { profiles, active: typeof active === 'string' ? active : undefined };
}

/** Read one store; missing file yields an empty set. Malformed fails loudly. */
async function readStore(path: string): Promise<ProfileFile> {
  try {
    return validateProfileFile(JSON.parse(await readFile(path, 'utf8')), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profiles: [] };
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/** Project profiles shadow global ones by name (deterministic order). */
export async function listProfiles(cwd = process.cwd()): Promise<Profile[]> {
  const paths = profilePaths(cwd);
  const [globalFile, projectFile] = await Promise.all([readStore(paths.global), readStore(paths.project)]);
  const merged = new Map<string, Profile>();
  for (const profile of globalFile.profiles) merged.set(profile.name, profile);
  for (const profile of projectFile.profiles) merged.set(profile.name, profile);
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getProfile(name: string, cwd = process.cwd()): Promise<Profile | undefined> {
  return (await listProfiles(cwd)).find((profile) => profile.name === name);
}

/** The profile marked active in either store (project flag wins). */
export async function activeProfileName(cwd = process.cwd()): Promise<string | undefined> {
  const paths = profilePaths(cwd);
  const project = await readStore(paths.project);
  if (project.active) return project.active;
  const global = await readStore(paths.global);
  return global.active;
}

export interface SaveProfileOptions {
  scope?: 'project' | 'global';
}

export async function saveProfile(profile: Profile, options: SaveProfileOptions = {}, cwd = process.cwd()): Promise<{ path: string; replaced: boolean }> {
  const validated = PROFILE_SCHEMA.safeParse(profile);
  if (!validated.success) {
    const issues = validated.error.issues.map((issue) => issue.message).join('; ');
    throw new Error(`Invalid profile '${String((profile as { name?: unknown }).name ?? '?')}': ${issues}`);
  }
  const entry = validated.data as Profile;
  const path = options.scope === 'global'
    ? profilePaths(cwd).global
    : options.scope === 'project'
      ? profilePaths(cwd).project
      : (await existsProject(cwd)) ? profilePaths(cwd).project : profilePaths(cwd).global;
  const store = await readStore(path);
  const existingIndex = store.profiles.findIndex((existing) => existing.name === entry.name);
  const replaced = existingIndex >= 0;
  if (replaced) store.profiles[existingIndex] = entry;
  else store.profiles.push(entry);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify({ profiles: store.profiles, active: store.active }, null, 2)}\n`, 'utf8');
  return { path, replaced };
}

export async function removeProfile(name: string, cwd = process.cwd()): Promise<boolean> {
  const paths = profilePaths(cwd);
  for (const path of [paths.project, paths.global]) {
    const store = await readStore(path);
    const next = store.profiles.filter((profile) => profile.name !== name);
    if (next.length !== store.profiles.length) {
      if (!next.length) { await unlink(path).catch(() => {}); return true; }
      await writeFile(path, `${JSON.stringify({ profiles: next, active: store.active === name ? undefined : store.active }, null, 2)}\n`, 'utf8');
      return true;
    }
  }
  return false;
}

/**
 * Resolve a profile into concrete session values: explicit AGENTFORGE_*
 * environment variables always win over the profile; the profile fills
 * whatever the environment left unset.
 */
export function resolveProfileToEnvValues(profile: Profile, env: NodeJS.ProcessEnv = process.env): { provider?: string; model?: string; permissionMode?: Profile['permissionMode'] } {
  return {
    provider: env.AGENTFORGE_PROVIDER ?? profile.provider,
    model: env.AGENTFORGE_MODEL ?? profile.model,
    permissionMode: profile.permissionMode,
  };
}

async function existsProject(cwd: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises');
    const info = await stat(join(resolve(cwd), '.agentforge'));
    return info.isDirectory();
  } catch {
    return false;
  }
}

export async function setActiveProfile(name: string, scope: 'project' | 'global', cwd = process.cwd()): Promise<void> {
  const path = scope === 'global' ? profilePaths(cwd).global : profilePaths(cwd).project;
  const store = await readStore(path);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify({ profiles: store.profiles, active: name }, null, 2)}\n`, 'utf8');
}
