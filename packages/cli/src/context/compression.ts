import type { AgentInterceptors, Message } from '@agentforge-oss/core';

export interface CompressionOptions {
  /** Fold the middle of the conversation when total content exceeds this many chars. */
  maxChars?: number;
  /** Recent messages (after the system prompt) kept verbatim. */
  keepRecent?: number;
  /** Folded-message text cap. */
  foldTextCap?: number;
}

export const DEFAULT_MAX_CHARS = 96_000;
export const DEFAULT_KEEP_RECENT = 20;
const DEFAULT_FOLD_CAP = 200;

function contentChars(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}

/**
 * Phase D: live context compression. A preRequest interceptor that folds the
 * middle of long conversations into one compact marker message, keeping the
 * system prompt and the most recent messages verbatim. Deterministic — no
 * model call — so it never surprises on cost or latency.
 */
export function createCompressionInterceptor(options: CompressionOptions = {}): NonNullable<AgentInterceptors['preRequest']>[number] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const keepRecent = options.keepRecent ?? DEFAULT_KEEP_RECENT;
  const foldCap = options.foldTextCap ?? DEFAULT_FOLD_CAP;
  return async (request) => {
    const messages = request.messages;
    if (contentChars(messages) <= maxChars || messages.length <= keepRecent + 2) return undefined;
    const system = messages.filter((message) => message.role === 'system');
    const rest = messages.filter((message) => message.role !== 'system');
    const middle = rest.slice(0, rest.length - keepRecent);
    const recent = rest.slice(rest.length - keepRecent);
    const folded = middle.map((message) => {
      const text = message.content.length > foldCap ? `${message.content.slice(0, foldCap)}…` : message.content;
      return `${message.role}: ${text.replace(/\s+/g, ' ')}`;
    });
    const marker: Message = { role: 'user', content: `[context compacted — ${middle.length} earlier message(s) folded]\n${folded.join('\n')}` };
    return { ...request, messages: [...system, marker, ...recent] };
  };
}
