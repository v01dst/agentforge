import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { McpConnection } from '../src/client.js';
import { jsonSchemaToZod, mcpToolToToolLike, toolsFromConnection } from '../src/tools.js';

async function makeFakeServer(): Promise<{ client: McpConnection; close(): Promise<void> }> {
  const server = new Server({ name: 'fake-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: 'Echo the provided text',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', description: 'text to echo' } },
          required: ['text'],
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === 'boom') return { isError: true, content: [{ type: 'text', text: 'kaboom' }] };
    const args = request.params.arguments as { text?: string };
    return { content: [{ type: 'text', text: `echo:${args.text ?? ''}` }] };
  });
  const [clientTransport, serverTransport] = await InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'agentforge-test', version: '0.0.0' });
  void client.connect(clientTransport);
  void server.connect(serverTransport);
  const connection: McpConnection = {
    serverName: 'fake',
    listTools: async () => {
      const response = await client.listTools();
      return response.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as Record<string, unknown> }));
    },
    callTool: async (name, args) => await client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> }),
    close: async () => { await client.close(); await server.close(); },
  };
  return { client: connection, close: connection.close };
}

test('jsonSchemaToZod maps primitive object properties and required flags', () => {
  const schema = jsonSchemaToZod({
    type: 'object',
    properties: {
      text: { type: 'string', description: 'the text' },
      count: { type: 'integer' },
      flag: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string' } },
      extra: { type: 'string' },
    },
    required: ['text'],
  }) as z.ZodObject;
  const parsed = schema.parse({ text: 'hi', unknownKey: true });
  assert.equal(parsed.text, 'hi');
  assert.throws(() => schema.parse({}));
  // Present-but-wrong-typed optional fields are rejected.
  assert.ok(!schema.safeParse({ text: 'x', count: 'not-a-number' }).success);
});

test('mcpToolToToolLike namespaces tools and tags restrictive permissions', async () => {
  const { client, close } = await makeFakeServer();
  try {
    const refs = await client.listTools();
    const tool = mcpToolToToolLike(client, refs[0]!);
    assert.equal(tool.name, 'fake.echo');
    assert.deepEqual(tool.permissions, ['mcp:fake']);
    const output = await tool.execute({ text: 'hi' }, { runId: 't', signal: new AbortController().signal });
    assert.equal(output, 'echo:hi');
  } finally { await close(); }
});

test('toolsFromConnection adapts listed tools end-to-end', async () => {
  const { client, close } = await makeFakeServer();
  try {
    const tools = await toolsFromConnection(client);
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, 'fake.echo');
  } finally { await close(); }
});

test('tool errors from the server surface as thrown errors', async () => {
  const { client, close } = await makeFakeServer();
  try {
    const refs = await client.listTools();
    const boom = mcpToolToToolLike(client, { ...refs[0]!, name: 'boom', description: 'always fails' });
    await assert.rejects(() => boom.execute({ text: 'x' }, { runId: 't', signal: new AbortController().signal }), /kaboom/);
  } finally { await close(); }
});
