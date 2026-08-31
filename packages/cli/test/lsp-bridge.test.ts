import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLspTools } from '../src/lsp/tools.js';
import {
  defaultLspConfig,
  formatDiagnostic,
  readLspConfig,
  serverForFile,
  TYPESCRIPT_SERVER,
  type LspServerConfig,
} from '../src/lsp/lsp.js';

const context = { runId: 'test', signal: new AbortController().signal } as never;

/** Minimal stdio LSP server: replies to initialize/diagnostic/hover, ignores notifications. */
const MOCK_SERVER = `
const readline = require('node:readline');
let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd < 0) return;
    const header = buffer.slice(0, headerEnd).toString('utf8');
    const length = Number(/Content-Length: *(\\d+)/i.exec(header)?.[1] ?? 0);
    if (buffer.length < headerEnd + 4 + length) return;
    const body = buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
    buffer = buffer.slice(headerEnd + 4 + length);
    handle(JSON.parse(body));
  }
});
function handle(message) {
  if (message.id === undefined) return;
  let result = null;
  if (message.method === 'initialize') result = { capabilities: { diagnosticProvider: { interFileDependencies: false } } };
  else if (message.method === 'textDocument/diagnostic') result = { kind: 'full', items: [
    { range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } }, severity: 1, message: 'mock type error', source: 'mock-ls' },
    { range: { start: { line: 5, character: 0 }, end: { line: 5, character: 2 } }, severity: 2, message: 'mock warning' },
  ] };
  else if (message.method === 'textDocument/hover') result = { contents: { kind: 'markdown', value: 'mock hover docs' } };
  const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
  process.stdout.write('Content-Length: ' + Buffer.byteLength(payload) + '\\r\\n\\r\\n' + payload);
}
`;

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'af-lsp-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function seedMockProject(root: string): Promise<void> {
  await mkdir(join(root, '.agentforge'), { recursive: true });
  const serverPath = join(root, 'mock-server.cjs');
  await writeFile(serverPath, MOCK_SERVER, 'utf8');
  await writeFile(join(root, '.agentforge', 'lsp.json'), JSON.stringify({
    servers: [{ id: 'mock', command: process.execPath, args: [serverPath], extensions: ['.ts', '.tsx'] }],
  }, null, 2), 'utf8');
  await writeFile(join(root, 'sample.ts'), 'const value: number = 1;\n\nconst broken: string = value;\n', 'utf8');
}

test('config: defaults to the TS-first server; custom servers parse and validate', async () => {
  await withTemp(async (root) => {
    const defaults = await readLspConfig(root);
    assert.equal(defaults.servers.length, 1);
    assert.equal(defaults.servers[0]!.id, 'typescript');
    assert.ok(defaults.servers[0]!.extensions.includes('.ts'));
    await seedMockProject(root);
    const custom = await readLspConfig(root);
    assert.equal(custom.servers[0]!.id, 'mock');
    assert.deepEqual(serverForFile(custom, 'a/b.ts'), custom.servers[0]);
    assert.equal(serverForFile(custom, 'notes.md'), undefined);
  });
});

test('serverForFile matches the TS server case-insensitively by extension', () => {
  const config = defaultLspConfig();
  assert.equal(serverForFile(config, 'src/App.TSX')?.id, 'typescript');
  assert.equal(serverForFile(config, 'src/readme.md'), undefined);
});

test('lsp_diagnostics returns formatted findings through a real stdio round-trip', async () => {
  await withTemp(async (root) => {
    await seedMockProject(root);
    const [tool] = createLspTools({ root });
    const result = await tool!.execute({ path: 'sample.ts' }, context) as { ok: boolean; count: number; diagnostics: string[] };
    assert.equal(result.ok, true);
    assert.equal(result.count, 2);
    assert.match(result.diagnostics[0], /sample\.ts:3:5 error: mock type error \(mock-ls\)/);
    assert.match(result.diagnostics[1], /sample\.ts:6:1 warning: mock warning/);
  });
});

test('lsp_hover returns server contents for a position', async () => {
  await withTemp(async (root) => {
    await seedMockProject(root);
    const [, hover] = createLspTools({ root });
    const result = await hover!.execute({ path: 'sample.ts', line: 0, character: 6 }, context) as { ok: boolean; contents: string };
    assert.equal(result.ok, true);
    assert.equal(result.contents, 'mock hover docs');
  });
});

test('path escapes are refused and unknown extensions report honestly', async () => {
  await withTemp(async (root) => {
    await seedMockProject(root);
    const [tool] = createLspTools({ root });
    const escape = await tool!.execute({ path: '../outside.ts' }, context) as { ok: boolean; error?: string };
    assert.equal(escape.ok, false);
    assert.match(escape.error!, /escapes the workspace/);
    const unknown = await tool!.execute({ path: 'notes.md' }, context) as { ok: boolean; error?: string };
    assert.equal(unknown.ok, false);
    assert.match(unknown.error!, /No language server configured/);
  });
});

test('formatDiagnostic renders file:line:col severity message', () => {
  const config: LspServerConfig = TYPESCRIPT_SERVER;
  assert.ok(config.command);
  const line = formatDiagnostic({
    range: { start: { line: 9, character: 3 }, end: { line: 9, character: 7 } },
    severity: 2,
    message: 'unused variable',
    source: 'ts',
  }, '/tmp/x/file.ts', '/tmp/x');
  assert.equal(line, 'file.ts:10:4 warning: unused variable (ts)');
});
