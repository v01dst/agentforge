import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface McpServerConfig {
  name: string;
  /** Executable plus arguments launched over stdio, e.g. ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."] */
  command: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** A plugin is a local module path exporting a default plugin object. */
export interface PluginEntry {
  name?: string;
  path: string;
}

export interface ExtensionsFile {
  plugins?: Array<string | PluginEntry>;
  mcp?: {
    servers?: McpServerConfig[];
  };
}

export const EXTENSIONS_DIR = '.agentforge';
export const EXTENSIONS_FILE = 'extensions.json';

export function extensionsPath(cwd = process.cwd()): string {
  return join(resolve(cwd), EXTENSIONS_DIR, EXTENSIONS_FILE);
}

export async function readExtensions(cwd = process.cwd()): Promise<ExtensionsFile> {
  try {
    return JSON.parse(await readFile(extensionsPath(cwd), 'utf8')) as ExtensionsFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Could not read ${extensionsPath(cwd)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeExtensions(extensions: ExtensionsFile, cwd = process.cwd()): Promise<void> {
  await mkdir(join(resolve(cwd), EXTENSIONS_DIR), { recursive: true });
  await writeFile(extensionsPath(cwd), `${JSON.stringify(extensions, null, 2)}\n`);
}
