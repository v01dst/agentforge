import type { ModelRequest, ToolCall, ToolExecutionResult } from './types.js';

/**
 * Typed waterfall interceptor seam (Phase N).
 *
 * Listeners run in registration order and may transform the value flowing
 * through the waterfall by returning a replacement, or pass it through by
 * returning void. `preTool` listeners deny an execution by returning a
 * reason string. `turnStopping` is serial: each listener sees the previous
 * listener's output.
 *
 * Everything user-extensible hooks the loop through this seam — reflection,
 * compression, safety guards, observability — so the loop itself stays small.
 */
export interface AgentInterceptors {
  /** Waterfall over the claimed user input before the first step; may rewrite it. */
  preStep?: Array<(context: { input: string; runId: string }) => Promise<string | void>>;
  /** Waterfall over the outgoing model request; may return a rewritten request. */
  preRequest?: Array<(request: ModelRequest) => Promise<ModelRequest | void>>;
  /** Waterfall before each tool execution; returning a string denies with that reason. */
  preTool?: Array<(call: ToolCall) => Promise<string | void>>;
  /** Observers of completed tool executions (success or failure). */
  postTool?: Array<(execution: ToolExecutionResult) => Promise<void>>;
  /** Serial hooks when the turn is about to complete; may rewrite the output. */
  turnStopping?: Array<(result: { output: string; iterations: number }) => Promise<string | void>>;
}

/** Fold a waterfall: each listener may replace the value; void passes through. */
export async function foldWaterfall<T>(
  listeners: Array<(value: T) => Promise<T | void>> | undefined,
  initial: T,
): Promise<T> {
  let value = initial;
  for (const listener of listeners ?? []) {
    const replacement = await listener(value);
    if (replacement !== undefined && replacement !== null) value = replacement;
  }
  return value;
}

/** True when any preTool listener denies the call; returns the denial reason. */
export async function firstDenial(
  listeners: Array<(call: ToolCall) => Promise<string | void>> | undefined,
  call: ToolCall,
): Promise<string | undefined> {
  for (const listener of listeners ?? []) {
    const denial = await listener(call);
    if (typeof denial === 'string') return denial;
  }
  return undefined;
}

/** Run serial observers that may rewrite the output; last replacement wins. */
export async function foldSerial(
  listeners: Array<(result: { output: string; iterations: number }) => Promise<string | void>> | undefined,
  result: { output: string; iterations: number },
): Promise<string> {
  let output = result.output;
  for (const listener of listeners ?? []) {
    const replacement = await listener({ output, iterations: result.iterations });
    if (typeof replacement === 'string') output = replacement;
  }
  return output;
}
