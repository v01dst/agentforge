import { z } from 'zod';
import { defineTool } from './tool.js';

function getPath(value: unknown, path: string): unknown { return path.split('.').filter(Boolean).reduce<unknown>((current, key) => current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, value); }
export const jsonTransformTool = defineTool({ name: 'json_transform', description: 'Select, pick, or omit fields from JSON data.',
  input: z.discriminatedUnion('operation', [z.object({ operation: z.literal('get'), value: z.unknown(), path: z.string() }), z.object({ operation: z.literal('pick'), value: z.record(z.unknown()), keys: z.array(z.string()) }), z.object({ operation: z.literal('omit'), value: z.record(z.unknown()), keys: z.array(z.string()) })]),
  execute(input) { if (input.operation === 'get') return getPath(input.value, input.path); const entries = Object.entries(input.value).filter(([key]) => input.operation === 'pick' ? input.keys.includes(key) : !input.keys.includes(key)); return Object.fromEntries(entries); },
});

export function createMockWebSearchTool(entries: Record<string, Array<{ title: string; url: string; snippet: string }>> = {}) { return defineTool({ name: 'web_search', description: 'Deterministic web-search fixture for tests and offline examples.', input: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(10).default(5) }), output: z.object({ query: z.string(), results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string() })) }), execute: ({ query, limit }) => ({ query, results: (entries[query] ?? []).slice(0, limit) }) }); }
export const webSearchMockTool = createMockWebSearchTool();
