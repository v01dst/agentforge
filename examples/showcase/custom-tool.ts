import { Agent } from '@agentforge-oss/core';
import { defineTool } from '@agentforge-oss/tools';
import { z } from 'zod';
import { ScriptedModel } from './demo-model.js';

const inventory = defineTool({
  name: 'inventory_lookup',
  description: 'Look up a product by SKU.',
  input: z.object({ sku: z.string().min(1) }),
  output: z.object({ sku: z.string(), available: z.boolean() }),
  execute: async ({ sku }) => ({ sku, available: sku === 'AF-001' }),
});

export const agent = new Agent({
  name: 'inventory-agent',
  model: new ScriptedModel([
    { toolCalls: [{ id: 'lookup-1', name: 'inventory_lookup', arguments: { sku: 'AF-001' } }] },
    { content: 'AF-001 is available.' },
  ]),
  tools: [inventory],
});

export const run = (input = 'Is AF-001 available?') => agent.run(input);
if (import.meta.url === `file://${process.argv[1]}`) console.log((await run()).output);
