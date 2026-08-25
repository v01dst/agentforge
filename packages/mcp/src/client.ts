import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** One configured MCP server from .agentforge/extensions.json. */
export interface McpServerConfig {
  name: string;
  /** Executable plus arguments launched over stdio, e.g. ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."] */
  command: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpToolRef {
  name: string;
  title?: string;
  description?: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface McpConnection {
  readonly serverName: string;
  listTools(): Promise<McpToolRef[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Launch an MCP server over stdio and return a thin typed client.
 * The child process inherits nothing except the provided env additions;
 * `close()` terminates it.
 */
export async function connectMcpServer(config: McpServerConfig): Promise<McpConnection> {
  const [command, ...args] = config.command;
  if (!command) throw new Error(`MCP server "${config.name}" has an empty command.`);
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: config.cwd,
    env: { ...(config.env ?? {}) } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'agentforge', version: '0.0.1' });
  try {
    await client.connect(transport, { timeout: 15_000 });
  } catch (error) {
    await transport.close().catch(() => {});
    throw new Error(`MCP server "${config.name}" failed to start (${config.command.join(' ')}): ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    serverName: config.name,
    async listTools(): Promise<McpToolRef[]> {
      const response = await client.listTools();
      return (response.tools ?? []).map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
      }));
    },
    async callTool(name: string, toolArgs: unknown): Promise<unknown> {
      const response = await client.callTool({ name, arguments: (toolArgs ?? {}) as Record<string, unknown> });
      return response;
    },
    async close(): Promise<void> {
      await client.close();
      await transport.close().catch(() => {});
    },
  };
}
