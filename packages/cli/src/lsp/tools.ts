import { z } from 'zod';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ToolLike } from '@agentforge-oss/core';
import { LspClient, readLspConfig, serverForFile, formatDiagnostic, type LspBridgeConfig } from './lsp.js';

/**
 * Shared LSP client manager (Phase I): one client per server config, started
 * lazily, reused across tool calls, disposed on process exit.
 */
export class LspManager {
  private config: LspBridgeConfig | undefined;
  private readonly clients = new Map<string, LspClient>();

  constructor(private readonly root: string) {}

  private async clientFor(filePath: string): Promise<LspClient | undefined> {
    this.config ??= await readLspConfig(this.root);
    const server = serverForFile(this.config, filePath);
    if (!server) return undefined;
    let client = this.clients.get(server.id);
    if (!client) {
      client = new LspClient({ ...server, rootUri: server.rootUri ?? this.root }, this.root);
      this.clients.set(server.id, client);
    }
    return client;
  }

  async diagnostics(absolutePath: string, settleMs?: number): Promise<{ formatted: string[]; count: number } | { error: string }> {
    try {
      const client = await this.clientFor(absolutePath);
      if (!client) return { error: `No language server configured for ${absolutePath} (see .agentforge/lsp.json; TypeScript is the default).` };
      const diagnostics = await client.diagnostics(absolutePath, settleMs);
      return { formatted: diagnostics.map((diagnostic) => formatDiagnostic(diagnostic, absolutePath, this.root)), count: diagnostics.length };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async hover(absolutePath: string, line: number, character: number): Promise<{ contents: string } | { error: string }> {
    try {
      const client = await this.clientFor(absolutePath);
      if (!client) return { error: `No language server configured for ${absolutePath}.` };
      const hover = await client.hover(absolutePath, line, character);
      if (!hover) return { contents: '' };
      return { contents: hover.contents };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async dispose(): Promise<void> {
    for (const client of this.clients.values()) await client.dispose().catch(() => {});
    this.clients.clear();
  }
}

function resolveInsideRoot(root: string, candidate: string): string | undefined {
  const full = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const rel = relative(root, full);
  if (rel === '' || rel.startsWith('..')) return undefined;
  return full;
}

/**
 * LSP tools (Phase I): observe-only intelligence about code health.
 * `lsp_diagnostics` — real language-server diagnostics for one file.
 * `lsp_hover` — type/signature information at a position.
 * Diagnostics never gate anything; they are reported as findings.
 */
export function createLspTools(options: { root: string }): ToolLike[] {
  const root = resolve(options.root);
  const manager = new LspManager(root);

  if (typeof process !== 'undefined' && typeof process.on === 'function') {
    process.once('exit', () => { void manager.dispose(); });
  }

  const diagnosticsTool: ToolLike = {
    name: 'lsp_diagnostics',
    description: [
      'Run the configured language server on a file and return its diagnostics',
      '(errors, warnings, hints). TypeScript servers are used by default for JS/TS;',
      'custom servers live in .agentforge/lsp.json.',
      'Use after editing a file to catch type and syntax problems.',
    ].join(' '),
    inputSchema: z.object({
      path: z.string().min(1).describe('File to check (workspace-relative or absolute).'),
    }),
    async execute(input) {
      const parsed = input as { path: string };
      const absolutePath = resolveInsideRoot(root, parsed.path);
      if (!absolutePath) return { ok: false, error: `Path escapes the workspace root; refusing lsp_diagnostics on ${parsed.path}.` };
      const result = await manager.diagnostics(absolutePath);
      if ('error' in result) return { ok: false, error: result.error };
      return {
        ok: true,
        count: result.count,
        diagnostics: result.count ? result.formatted : '(no diagnostics — clean)',
      };
    },
  };

  const hoverTool: ToolLike = {
    name: 'lsp_hover',
    description: [
      'Get type and signature information for the symbol at a position in a file',
      'through the configured language server (hover request).',
      'Positions are zero-based lines and characters.',
    ].join(' '),
    inputSchema: z.object({
      path: z.string().min(1).describe('File containing the symbol.'),
      line: z.number().int().min(0).describe('Zero-based line.'),
      character: z.number().int().min(0).describe('Zero-based character.'),
    }),
    async execute(input) {
      const parsed = input as { path: string; line: number; character: number };
      const absolutePath = resolveInsideRoot(root, parsed.path);
      if (!absolutePath) return { ok: false, error: `Path escapes the workspace root; refusing lsp_hover on ${parsed.path}.` };
      const result = await manager.hover(absolutePath, parsed.line, parsed.character);
      if ('error' in result) return { ok: false, error: result.error };
      if (!result.contents) return { ok: true, contents: '(no hover information at this position)' };
      return { ok: true, contents: result.contents };
    },
  };

  return [diagnosticsTool, hoverTool];
}
