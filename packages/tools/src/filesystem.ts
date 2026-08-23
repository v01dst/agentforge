import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { defineTool } from './tool.js';

export interface FilesystemToolOptions { root: string; allowWrite?: boolean; maxBytes?: number; }
export function createFilesystemTool(options: FilesystemToolOptions) {
  const root = resolve(options.root);
  const safePath = (value: string) => { const full = resolve(root, value); const rel = relative(root, full); if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Path escapes the configured filesystem root'); return full; };
  return defineTool({ name: 'filesystem', description: 'Read or list files inside a configured sandbox root; writes require explicit opt-in.', permissions: options.allowWrite ? ['filesystem:read', 'filesystem:write'] : ['filesystem:read'],
    input: z.discriminatedUnion('operation', [z.object({ operation: z.literal('read'), path: z.string() }), z.object({ operation: z.literal('list'), path: z.string().default('.') }), z.object({ operation: z.literal('write'), path: z.string(), content: z.string() })]),
    output: z.object({ operation: z.string(), path: z.string(), content: z.string().optional(), entries: z.array(z.string()).optional(), bytes: z.number().optional() }),
    async execute(input) { const requestedPath = input.path ?? '.'; const path = safePath(requestedPath); if (input.operation === 'list') return { operation: input.operation, path: requestedPath, entries: await readdir(path) }; if (input.operation === 'read') { const buffer = await readFile(path); const max = options.maxBytes ?? 1_000_000; if (buffer.byteLength > max) throw new Error(`File exceeds ${max} byte limit`); return { operation: input.operation, path: requestedPath, content: buffer.toString('utf8'), bytes: buffer.byteLength }; } if (!options.allowWrite) throw new Error('Filesystem writes are disabled'); const bytes = Buffer.byteLength(input.content); if (bytes > (options.maxBytes ?? 1_000_000)) throw new Error('Write exceeds configured byte limit'); await writeFile(path, input.content, { encoding: 'utf8', flag: 'wx' }); return { operation: input.operation, path: requestedPath, bytes }; },
  });
}
