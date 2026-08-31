import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';

/**
 * LSP bridge (Phase I): a small, real JSON-RPC 2.0 client over stdio for
 * language servers. TS-first — when no configuration exists, AgentForge tries
 * `typescript-language-server --stdio` for JS/TS files. Custom servers are
 * declared in `.agentforge/lsp.json`:
 *
 *   { "servers": [{ "id": "py", "command": "pylsp", "extensions": [".py"] }] }
 *
 * The bridge is tool-scoped: servers start lazily on first use, are reused
 * per language, and are shut down through disposeLspServers(). All requests
 * carry timeouts; a dead server yields honest errors, never hangs.
 */

export interface LspServerConfig {
  id: string;
  command: string;
  args?: readonly string[];
  /** File extensions this server handles (e.g. ['.ts', '.tsx']). */
  extensions: readonly string[];
  /** Root passed to initialize (defaults to the workspace). */
  rootUri?: string;
}

export interface LspBridgeConfig {
  servers: LspServerConfig[];
}

export const LSP_CONFIG_FILE = '.agentforge/lsp.json';

export const TYPESCRIPT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'] as const;

export const TYPESCRIPT_SERVER: LspServerConfig = {
  id: 'typescript',
  command: 'typescript-language-server',
  args: ['--stdio'],
  extensions: TYPESCRIPT_EXTENSIONS,
};

/** Default TS-first configuration; used when no project config file exists. */
export function defaultLspConfig(): LspBridgeConfig {
  return { servers: [TYPESCRIPT_SERVER] };
}

export async function readLspConfig(root: string): Promise<LspBridgeConfig> {
  try {
    const raw = await readFile(join(root, LSP_CONFIG_FILE), 'utf8');
    const parsed = JSON.parse(raw) as { servers?: unknown };
    if (!Array.isArray(parsed.servers)) throw new Error(`${LSP_CONFIG_FILE} must contain a "servers" array.`);
    const servers = parsed.servers.map((entry) => {
      const server = entry as Record<string, unknown>;
      if (typeof server.id !== 'string' || typeof server.command !== 'string' || !Array.isArray(server.extensions)) {
        throw new Error('Each lsp server needs id (string), command (string), extensions (string[]).');
      }
      return {
        id: server.id,
        command: server.command,
        args: typeof server.args === 'string'
          ? server.args.split(' ').filter(Boolean)
          : Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === 'string') : undefined,
        extensions: server.extensions as string[],
      } satisfies LspServerConfig;
    });
    return { servers };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultLspConfig();
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export function serverForFile(config: LspBridgeConfig, filePath: string): LspServerConfig | undefined {
  const lower = filePath.toLowerCase();
  return config.servers.find((server) => server.extensions.some((extension) => lower.endsWith(extension.toLowerCase())));
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 over stdio with LSP Content-Length framing
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LspConnection {
  private process: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<(method: string, params: unknown) => void>();
  private crashed: Error | null = null;

  constructor(private readonly command: string, private readonly args: readonly string[] = []) {}

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandlers.add(handler);
  }

  private ensureProcess(): ChildProcess {
    if (this.process) return this.process;
    if (this.crashed) throw this.crashed;
    const child = spawn(this.command, [...this.args], { stdio: ['pipe', 'pipe', 'pipe'] });
    // Unref so idle servers never keep the host process alive; dispose()
    // (wired to process exit by LspManager) shuts them down explicitly.
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      (stream as unknown as { unref?: () => void } | null)?.unref?.();
    }
    child.on('error', (error) => {
      this.crashed = new Error(`Failed to start language server '${this.command}': ${error.message}`);
      this.rejectAll(this.crashed);
    });
    child.on('exit', (code) => {
      if (this.crashed === null && code !== 0 && code !== null) {
        this.crashed = new Error(`Language server '${this.command}' exited with code ${code}.`);
        this.rejectAll(this.crashed);
      }
      this.process = null;
    });
    child.stdout!.on('data', (chunk: Buffer) => this.consume(chunk));
    child.stderr!.on('data', () => { /* servers log verbosely; ignore */ });
    this.process = child;
    return child;
  }

  private rejectAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd).toString('utf8');
      const match = /Content-Length: *(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      if (this.buffer.length < headerEnd + 4 + length) return;
      const body = this.buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
      this.buffer = this.buffer.slice(headerEnd + 4 + length);
      this.dispatch(body);
    }
  }

  private dispatch(body: string): void {
    let message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(body);
    } catch {
      return;
    }
    if (message.id !== undefined && (message.method === undefined)) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      this.pending.delete(Number(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? 'LSP request failed'));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) {
      for (const handler of this.notificationHandlers) handler(message.method, message.params);
    }
  }

  notify(method: string, params: unknown): void {
    const child = this.ensureProcess();
    child.stdin!.write(this.frame(JSON.stringify({ jsonrpc: '2.0', method, params })));
  }

  async request<T = unknown>(method: string, params: unknown, timeoutMs = 10_000): Promise<T> {
    const child = this.ensureProcess();
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`LSP request '${method}' timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolveRequest as (value: unknown) => void,
        reject: rejectRequest,
        timer,
      });
      child.stdin!.write(this.frame(payload));
    });
  }

  private frame(payload: string): Buffer {
    return Buffer.concat([Buffer.from(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n`, 'utf8'), Buffer.from(payload, 'utf8')]);
  }

  async dispose(): Promise<void> {
    const child = this.process;
    this.process = null;
    if (!child) return;
    try { this.notify('exit', null); } catch { /* already gone */ }
    child.kill();
  }
}

// ---------------------------------------------------------------------------
// LSP client: initialize, diagnostics, hover
// ---------------------------------------------------------------------------

export interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number;
  message: string;
  source?: string;
}

const SEVERITY_LABELS: Record<number, string> = { 1: 'error', 2: 'warning', 3: 'information', 4: 'hint' };

export class LspClient {
  private connection: LspConnection | null = null;
  private initialized = false;
  private readonly openDocuments = new Set<string>();
  private readonly published = new Map<string, LspDiagnostic[]>();

  constructor(private readonly config: LspServerConfig, private readonly root: string) {}

  private async ensureInitialized(): Promise<LspConnection> {
    if (this.connection && this.initialized) return this.connection;
    const connection = this.connection ?? new LspConnection(this.config.command, this.config.args);
    if (!this.connection) {
      connection.onNotification((method, params) => {
        if (method === 'textDocument/publishDiagnostics') {
          const payload = params as { uri?: string; diagnostics?: LspDiagnostic[] };
          if (payload?.uri) this.published.set(lspUriToPath(payload.uri), payload.diagnostics ?? []);
        }
      });
      this.connection = connection;
    }
    const rootUri = `file://${this.config.rootUri ?? this.root}`;
    await connection.request('initialize', {
      processId: process.pid,
      rootUri,
      capabilities: {},
    }, 30_000);
    connection.notify('initialized', {});
    this.initialized = true;
    return connection;
  }

  private async openIfNew(connection: LspConnection, absolutePath: string): Promise<void> {
    if (this.openDocuments.has(absolutePath)) return;
    const text = await readFile(absolutePath, 'utf8');
    connection.notify('textDocument/didOpen', {
      textDocument: {
        uri: pathToLspUri(absolutePath),
        languageId: languageIdFor(this.config, absolutePath),
        version: 1,
        text,
      },
    });
    this.openDocuments.add(absolutePath);
  }

  /**
   * Diagnostics for one file: opens it (didOpen), waits a bounded settle
   * period for publishDiagnostics, then merges published + pull results.
   * Never gates — callers treat diagnostics as observe-only findings.
   */
  async diagnostics(absolutePath: string, settleMs = 400): Promise<LspDiagnostic[]> {
    const connection = await this.ensureInitialized();
    await this.openIfNew(connection, absolutePath);
    await new Promise((resolveWait) => setTimeout(resolveWait, settleMs));
    const fromPush = this.published.get(absolutePath) ?? [];
    let fromPull: LspDiagnostic[] = [];
    try {
      const pulled = await connection.request<{ kind?: string; items?: LspDiagnostic[] } | LspDiagnostic[] | null>('textDocument/diagnostic', { textDocument: { uri: pathToLspUri(absolutePath) } }, 5_000);
      if (Array.isArray(pulled)) fromPull = pulled;
      else if (pulled && Array.isArray(pulled.items)) fromPull = pulled.items;
    } catch { /* pull unsupported — push results still apply */ }
    return dedupe([...fromPush, ...fromPull]);
  }

  async hover(absolutePath: string, line: number, character: number): Promise<{ contents: string; range?: unknown } | undefined> {
    const connection = await this.ensureInitialized();
    await this.openIfNew(connection, absolutePath);
    const result = await connection.request<{ contents?: unknown; range?: unknown } | null>('textDocument/hover', {
      textDocument: { uri: pathToLspUri(absolutePath) },
      position: { line, character },
    }, 5_000);
    if (!result) return undefined;
    return { contents: hoverContentsToString(result.contents), range: result.range };
  }

  async dispose(): Promise<void> {
    if (this.connection && this.initialized) {
      try { await this.connection.request('shutdown', null, 2_000); } catch { /* best effort */ }
      try { this.connection.notify('exit', null); } catch { /* best effort */ }
    }
    await this.connection?.dispose();
    this.connection = null;
    this.initialized = false;
    this.openDocuments.clear();
  }
}

function dedupe(diagnostics: readonly LspDiagnostic[]): LspDiagnostic[] {
  const seen = new Set<string>();
  const out: LspDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.range?.start?.line}:${diagnostic.range?.start?.character}:${diagnostic.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(diagnostic);
  }
  return out;
}

function hoverContentsToString(contents: unknown): string {
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) return contents.map(hoverContentsToString).filter(Boolean).join('\n\n');
  if (contents && typeof contents === 'object') {
    const marked = contents as { value?: string; language?: string };
    if (typeof marked.value === 'string') return marked.value;
  }
  return '';
}

export function formatDiagnostic(diagnostic: LspDiagnostic, filePath: string, root: string): string {
  const severity = SEVERITY_LABELS[diagnostic.severity ?? 1] ?? 'error';
  const line = (diagnostic.range?.start?.line ?? 0) + 1;
  const character = (diagnostic.range?.start?.character ?? 0) + 1;
  const display = isAbsolute(filePath) ? relative(root, filePath) || filePath : filePath;
  return `${display}:${line}:${character} ${severity}: ${diagnostic.message}${diagnostic.source ? ` (${diagnostic.source})` : ''}`;
}

export function pathToLspUri(filePath: string): string {
  return `file://${isAbsolute(filePath) ? filePath : join(process.cwd(), filePath)}`;
}

export function lspUriToPath(uri: string): string {
  return uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
}

function languageIdFor(config: LspServerConfig, filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) return 'typescript';
  if (lower.endsWith('.tsx')) return 'typescriptreact';
  if (lower.endsWith('.jsx')) return 'javascriptreact';
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript';
  return config.id;
}
