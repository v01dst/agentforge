import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** A named model endpoint managed outside agentforge.config.ts. */
export interface ProviderEntry {
  name: string;
  protocol: 'openai' | 'anthropic' | 'google' | 'gemini' | 'openai-compatible';
  model?: string;
  baseUrl?: string;
  /** Environment variable holding the API key; never the key itself. */
  apiKeyEnv?: string;
}

const PROTOCOLS: ReadonlyArray<ProviderEntry['protocol']> = ['openai', 'anthropic', 'google', 'gemini', 'openai-compatible'];

export const PROVIDERS_DIR = '.agentforge';
export const PROVIDERS_FILE = `${PROVIDERS_DIR}/providers.json`;

export function providersFilePath(cwd = process.cwd()): string {
  return join(resolve(cwd), PROVIDERS_DIR, 'providers.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate one parsed entry; throws with a human-readable message. */
export function validateProviderEntry(value: unknown): ProviderEntry {
  if (!isRecord(value)) throw new Error('Provider entries must be objects.');
  const name = typeof value.name === 'string' ? value.name : '';
  if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(name)) throw new Error(`Provider name '${String(value.name)}' must start with a letter and use only letters, numbers, dots, underscores, or hyphens.`);
  const protocolText = typeof value.protocol === 'string' ? value.protocol : '';
  if (!(PROTOCOLS as readonly string[]).includes(protocolText)) throw new Error(`Provider '${name}': protocol must be one of ${PROTOCOLS.join(', ')}.`);
  const protocol = protocolText as ProviderEntry['protocol'];
  const entry: ProviderEntry = { name, protocol };
  if (typeof value.model === 'string' && value.model) entry.model = value.model;
  if (typeof value.baseUrl === 'string' && value.baseUrl) entry.baseUrl = value.baseUrl;
  if (value.apiKeyEnv === undefined || value.apiKeyEnv === '') {
    // optional
  } else if (typeof value.apiKeyEnv === 'string') entry.apiKeyEnv = value.apiKeyEnv;
  else throw new Error(`Provider '${name}': apiKeyEnv must be a variable name.`);
  if (entry.protocol === 'openai-compatible' && !entry.baseUrl) {
    throw new Error(`Provider '${name}': protocol 'openai-compatible' requires --base-url (for example https://openrouter.ai/api/v1).`);
  }
  return entry;
}

function validateProviderFile(parsed: unknown): ProviderEntry[] {
  if (parsed === null || parsed === undefined) return [];
  if (!isRecord(parsed) || !Array.isArray(parsed.providers)) throw new Error(`${PROVIDERS_FILE} must contain a "providers" array.`);
  return parsed.providers.map(validateProviderEntry);
}

export async function readProviderEntries(cwd = process.cwd()): Promise<ProviderEntry[]> {
  try {
    return validateProviderFile(JSON.parse(await readFile(providersFilePath(cwd), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export async function writeProviderEntries(entries: readonly ProviderEntry[], cwd = process.cwd()): Promise<void> {
  const path = providersFilePath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ providers: entries }, null, 2)}\n`, 'utf8');
}

export interface AddProviderOptions extends Omit<ProviderEntry, 'name'> {
  force?: boolean;
}

/** Insert or update a sidecar entry; returns whether an existing entry was replaced. */
export async function addProviderEntry(name: string, options: AddProviderOptions, cwd = process.cwd()): Promise<{ replaced: boolean; entry: ProviderEntry }> {
  const entries = await readProviderEntries(cwd);
  const existingIndex = entries.findIndex((entry) => entry.name === name);
  if (existingIndex >= 0 && !options.force) {
    throw new Error(`Provider '${name}' already exists in ${PROVIDERS_FILE}. Pass --force to replace it.`);
  }
  const entry = validateProviderEntry({ ...options, name });
  if (existingIndex >= 0) entries[existingIndex] = entry;
  else entries.push(entry);
  await writeProviderEntries(entries, cwd);
  return { replaced: existingIndex >= 0, entry };
}

export async function removeProviderEntry(name: string, cwd = process.cwd()): Promise<boolean> {
  const entries = await readProviderEntries(cwd);
  const next = entries.filter((entry) => entry.name !== name);
  if (next.length === entries.length) return false;
  await writeProviderEntries(next, cwd);
  return true;
}
