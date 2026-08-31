import type { ToolCall } from '@agentforge-oss/core';

export interface DoomLoopOptions {
  /**
   * Deny an identical tool call (same tool + arguments) after this many
   * consecutive repetitions. Defaults to 3: first call runs, one retry is
   * allowed, the third identical call is denied.
   */
  maxRepeats?: number;
}

/**
 * Doom-loop guard (Phase G): a preTool interceptor that denies a tool call
 * identical to the immediately preceding one(s) once the model starts
 * repeating itself verbatim. Returning a string denies the call with that
 * reason, steering the model to change approach instead of burning context.
 */
export function createDoomLoopGuard(options: DoomLoopOptions = {}): (call: ToolCall) => Promise<string | void> {
  const maxRepeats = options.maxRepeats ?? 3;
  let lastKey: string | undefined;
  let repeats = 0;
  return async (call: ToolCall) => {
    const key = `${call.name}:${JSON.stringify(call.arguments ?? null)}`;
    if (key === lastKey) repeats += 1;
    else {
      lastKey = key;
      repeats = 1;
    }
    if (repeats >= maxRepeats) {
      return `Tool ${call.name} has been called ${repeats} times in a row with identical arguments. Change your approach: adjust the arguments, gather new information, or explain the blocker instead of repeating the same call.`;
    }
    return undefined;
  };
}
