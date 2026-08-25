import { z, type ZodTypeAny } from 'zod';
import type { ToolLike } from '@agentforge-oss/core';
import { connectMcpServer, type McpConnection, type McpServerConfig, type McpToolRef } from './client.js';

export interface McpToolLoadResult {
  tools: ToolLike[];
  connections: McpConnection[];
  failures: Array<{ server: string; reason: string }>;
}

/**
 * Convert a JSON Schema subset (object with primitive-typed properties) to a
 * Zod schema. Unsupported shapes fall back to permissive validation; MCP
 * servers remain the authoritative validators of their own inputs.
 */
export function jsonSchemaToZod(schema: Record<string, unknown> | undefined): z.ZodType<unknown> {
  if (!schema || schema.type !== 'object' || typeof schema.properties !== 'object' || schema.properties === null) {
    return z.unknown();
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, raw] of Object.entries(schema.properties as Record<string, unknown>)) {
    const property = (raw ?? {}) as Record<string, unknown>;
    let base: ZodTypeAny;
    switch (property.type) {
      case 'string': base = z.string(); break;
      case 'number':
      case 'integer': base = z.number(); break;
      case 'boolean': base = z.boolean(); break;
      case 'array': {
        const items = (property.items ?? {}) as Record<string, unknown>;
        base = items.type === 'string' ? z.array(z.string())
          : items.type === 'number' || items.type === 'integer' ? z.array(z.number())
          : items.type === 'boolean' ? z.array(z.boolean())
          : z.array(z.unknown());
        break;
      }
      default: base = z.unknown();
    }
    if (typeof property.description === 'string') base = base.describe(property.description);
    shape[key] = required.has(key) ? base : base.optional();
  }
  return z.object(shape).passthrough();
}

/** Adapt one MCP tool reference into a core ToolLike scoped to its server. */
export function mcpToolToToolLike(connection: McpConnection, ref: McpToolRef): ToolLike {
  return {
    // Namespaced so tools from different servers cannot collide.
    name: `${connection.serverName}.${ref.name}`,
    description: ref.description ?? ref.title ?? `MCP tool ${ref.name} from server ${connection.serverName}`,
    inputSchema: jsonSchemaToZod(ref.inputSchema),
    // Restrictive by default: workspace policy must explicitly allow MCP tools.
    permissions: [`mcp:${connection.serverName}`],
    timeoutMs: 60_000,
    async execute(input: unknown) {
      const response = await connection.callTool(ref.name, input) as {
        content?: Array<{ type?: string; text?: string }>;
        isError?: boolean;
        structuredContent?: unknown;
      };
      if (response?.isError) {
        const text = response.content?.map((part) => part.text ?? '').join('\n');
        throw new Error(text || `MCP tool ${ref.name} reported an error`);
      }
      if (response?.structuredContent !== undefined) return response.structuredContent;
      const text = response?.content
        ?.filter((part) => !part.type || part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n');
      return text !== undefined && text !== '' ? text : response;
    },
  };
}

/**
 * Enumerate one live connection's tools as ToolLike objects.
 * Exported separately so transports other than stdio (e.g. in-memory tests)
 * can reuse the adaptation.
 */
export async function toolsFromConnection(connection: McpConnection): Promise<ToolLike[]> {
  const refs = await connection.listTools();
  return refs.map((ref) => mcpToolToToolLike(connection, ref));
}

/**
 * Connect every configured MCP server and expose all their tools as ToolLike.
 * Servers that fail to start are reported in `failures`; healthy servers stay usable.
 * Callers MUST call `close()` on returned connections when done (e.g. on chat exit).
 */
export async function loadMcpTools(servers: readonly McpServerConfig[]): Promise<McpToolLoadResult> {
  const tools: ToolLike[] = [];
  const connections: McpConnection[] = [];
  const failures: McpToolLoadResult['failures'] = [];
  for (const config of servers) {
    try {
      const connection = await connectMcpServer(config);
      connections.push(connection);
      tools.push(...await toolsFromConnection(connection));
    } catch (error) {
      failures.push({ server: config.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { tools, connections, failures };
}
