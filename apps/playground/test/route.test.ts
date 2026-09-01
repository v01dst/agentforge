import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GET, POST } from '../app/api/runs/route';

const seenRequests: Array<{ url?: string; method?: string; auth?: string | null; model?: string | null }> = [];
let stub: Server;
let stubPort = 0;

const runsPath = join(mkdtempSync(join(tmpdir(), 'agentforge-pg-')), 'playground-runs.jsonl');

async function post(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await POST(new Request('http://test.local/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  process.env.AGENTFORGE_PLAYGROUND_RUNS_PATH = runsPath;
  delete process.env.AGENTFORGE_IN_MEMORY_RUNS;
  process.env.STUB_KEY = 'server-side-secret';
  stub = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      let model: string | null = null;
      try { model = (JSON.parse(body) as { model?: string }).model ?? null; } catch { /* ignore */ }
      seenRequests.push({ url: request.url, method: request.method, auth: request.headers.authorization ?? null, model });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'stub-run-1',
        choices: [{ message: { content: 'STUB PROXY REPLY' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }));
    });
  });
  await new Promise<void>((resolveListen) => {
    stub.once('error', (error) => { throw error; });
    stub.listen(0, '127.0.0.1', () => {
      stubPort = (stub.address() as { port: number }).port;
      resolveListen();
    });
  });
}, 20_000);

afterAll(async () => {
  await new Promise<void>((closeDone) => stub.close(() => closeDone()));
  rmSync(runsPath, { force: true });
});

describe('playground runs API', () => {
  it('rejects a run without a selected provider (mock removed in 0.8)', async () => {
    const { status, body } = await post({ input: { topic: 'no provider' } });
    expect(status).toBe(400);
    expect(String(body.error)).toContain('No provider selected');
  });

  it('persists a completed run to the store', async () => {
    const { status, body } = await post({
      provider: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${stubPort}/v1`,
      model: 'stub-model-7b',
      apiKeyEnv: 'STUB_KEY',
      input: { topic: 'stored run smoke' },
    });
    expect(status).toBe(200);
    expect(String(body.runId)).toMatch(/^workflow_/);
    const history = await GET();
    const data = (await history.json()) as { runs: Array<{ id: string; input?: unknown }> };
    const stored = data.runs.find((run) => run.id === body.runId);
    expect(stored?.input).toBe('stored run smoke');
  });

  it('routes openai-compatible requests to the configured endpoint using env credentials', async () => {
    const { status, body } = await post({
      provider: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${stubPort}/v1`,
      model: 'stub-model-7b',
      apiKeyEnv: 'STUB_KEY',
      input: { topic: 'proxied playground run' },
    });
    expect(status).toBe(200);
    expect(body.output).toBe('STUB PROXY REPLY');
    const usage = body.usage as { inputTokens?: number; totalTokens?: number };
    expect(usage.totalTokens).toBeGreaterThan(0);
    const forwarded = seenRequests.at(-1);
    expect(forwarded?.url).toBe('/v1/chat/completions');
    expect(forwarded?.auth).toBe('Bearer server-side-secret');
    expect(forwarded?.model).toBe('stub-model-7b');
  });

  it('rejects unconfigured providers with the missing variable named', async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { status, body } = await post({ provider: 'anthropic' });
      expect(status).toBe(400);
      expect(String(body.error)).toContain('ANTHROPIC_API_KEY');
      expect(JSON.stringify(body)).not.toContain('sk-');
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
    }
  });

  it('requires a base URL for openai-compatible providers', async () => {
    const { status, body } = await post({ provider: 'openai-compatible' });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/base URL/i);
  });

  it('rejects unsupported provider names', async () => {
    const { status, body } = await post({ provider: 'carrier-pigeon' });
    expect(status).toBe(400);
    expect(String(body.error)).toContain('carrier-pigeon');
  });

  it('persists every completed run to the JSONL store', () => {
    const lines = readFileSync(runsPath, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const kinds = lines.map((line) => (JSON.parse(line) as { kind: string }).kind);
    expect(kinds.filter((kind) => kind === 'run').length).toBeGreaterThanOrEqual(2);
  });
});
