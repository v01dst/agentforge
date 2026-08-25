import { readExtensions, type ExtensionsFile } from '../extensions/store.js';

export interface ProjectMcpResult {
  tools: unknown[];
  failures: Array<{ server: string; reason: string }>;
}

/**
 * Connect every MCP server configured in `.agentforge/extensions.json` and
 * return their tools as ToolLike objects ready for `new Agent({ tools })`.
 * Connections are closed automatically on process exit.
 */
export async function projectMcpTools(extensionsOverride?: ExtensionsFile, cwd = process.cwd()): Promise<ProjectMcpResult> {
  const extensions = extensionsOverride ?? await readExtensions(cwd);
  const servers = extensions.mcp?.servers ?? [];
  if (!servers.length) return { tools: [], failures: [] };
  const { loadMcpTools } = await import('@agentforge-oss/mcp');
  const result = await loadMcpTools(servers);
  for (const connection of result.connections) {
    process.once('beforeExit', () => { void connection.close().catch(() => {}); });
    process.once('SIGINT', () => { void connection.close().catch(() => {}); });
  }
  return { tools: result.tools, failures: result.failures };
}
