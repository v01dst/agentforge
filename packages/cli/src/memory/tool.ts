import { z } from 'zod';
import { defineTool } from '@agentforge-oss/tools';
import {
  addMemoryEntry,
  loadMemory,
  removeMemoryEntry,
  replaceMemoryEntry,
  type MemoryTarget,
} from './store.js';

export interface MemoryToolOptions {
  root: string;
  /** Store in the global (~/.agentforge) scope instead of the project. */
  global?: boolean;
  /** When true, write actions are rejected (read-only inspection). */
  readOnly?: boolean;
}

const inputSchema = z.object({
  action: z.enum(['add', 'replace', 'remove']),
  /** memory = agent notes; user = user profile. */
  target: z.enum(['memory', 'user']).default('memory'),
  content: z.string().optional(),
  /** Unique substring identifying the entry to replace/remove. */
  old_text: z.string().optional(),
});

/**
 * The agent's curated persistent memory. Entries live in MEMORY.md / USER.md
 * and are injected into the system prompt as a frozen snapshot at session
 * start; tool results always reflect the live state.
 */
export function createMemoryTool(options: MemoryToolOptions) {
  return defineTool({
    name: 'memory',
    description:
      'Persist durable facts for future sessions: add/replace/remove entries in your memory notes (target=memory) or the user profile (target=user). Entries are injected into future sessions automatically.',
    permissions: ['filesystem:write'],
    timeoutMs: 10_000,
    input: inputSchema,
    output: z.object({
      ok: z.boolean(),
      message: z.string(),
      entries: z.array(z.string()),
      used: z.number(),
      limit: z.number(),
    }),
    async execute(input) {
      const write = async (
        operation: (target: MemoryTarget) => Promise<{ ok: boolean; message: string; snapshot: { entries: string[]; used: number; limit: number } }>,
      ) => {
        if (options.readOnly) {
          const snapshot = await loadMemory(input.target as MemoryTarget, options.root, options.global);
          return { ok: false, message: 'Memory writes are disabled (read-only context).', entries: snapshot.entries, used: snapshot.used, limit: snapshot.limit };
        }
        const result = await operation(input.target as MemoryTarget);
        return { ok: result.ok, message: result.message, entries: result.snapshot.entries, used: result.snapshot.used, limit: result.snapshot.limit };
      };
      if (input.action === 'add') {
        if (!input.content) {
          const snapshot = await loadMemory(input.target as MemoryTarget, options.root, options.global);
          return { ok: false, message: 'content is required for action=add.', entries: snapshot.entries, used: snapshot.used, limit: snapshot.limit };
        }
        return write((target) => addMemoryEntry(target, input.content!, { cwd: options.root, global: options.global }));
      }
      if (input.action === 'replace') {
        if (!input.old_text || !input.content) {
          const snapshot = await loadMemory(input.target as MemoryTarget, options.root, options.global);
          return { ok: false, message: 'old_text and content are required for action=replace.', entries: snapshot.entries, used: snapshot.used, limit: snapshot.limit };
        }
        return write((target) => replaceMemoryEntry(target, input.old_text!, input.content!, { cwd: options.root, global: options.global }));
      }
      if (!input.old_text) {
        const snapshot = await loadMemory(input.target as MemoryTarget, options.root, options.global);
        return { ok: false, message: 'old_text is required for action=remove.', entries: snapshot.entries, used: snapshot.used, limit: snapshot.limit };
      }
      return write((target) => removeMemoryEntry(target, input.old_text!, { cwd: options.root, global: options.global }));
    },
  });
}
