import type { ToolContext, ToolLike } from '@agentforge-oss/core';
import { z } from 'zod';

export interface ToolDefinition<TInput, TOutput> {
  name: string;
  description: string;
  input: z.ZodType<TInput>;
  output?: z.ZodType<TOutput>;
  permissions?: string[];
  timeoutMs?: number;
  retries?: number;
  metadata?: Record<string, unknown>;
  execute(input: TInput, context: ToolContext): TOutput | Promise<TOutput>;
}

export interface DefinedTool<TInput, TOutput> extends ToolLike {
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema?: z.ZodType<TOutput>;
  readonly metadata?: Record<string, unknown>;
  execute(input: unknown, context: ToolContext): Promise<TOutput>;
}

export function defineTool<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): DefinedTool<TInput, TOutput> {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.input,
    outputSchema: definition.output,
    permissions: definition.permissions,
    timeoutMs: definition.timeoutMs,
    retries: definition.retries,
    metadata: definition.metadata,
    async execute(value, context) {
      const input = definition.input.parse(value);
      const output = await definition.execute(input, context);
      return definition.output ? definition.output.parse(output) : output;
    },
  };
}
