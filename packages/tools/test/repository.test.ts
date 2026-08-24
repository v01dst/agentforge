import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createListFilesTool, createReadFileTool, createSearchTextTool } from '../src/repository.js';

const ctx = { runId: 'test', signal: new AbortController().signal } as never;

describe('repository tools', () => {
  let root: string;
  let cleanup = () => {};

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'repo-tools-'));
    // Create levels separately: recursive:true is unreliable under some sandboxes.
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'node_modules'));
    await mkdir(join(root, join('node_modules', 'pkg')));
    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.gitignore'), '# comment\n*.log\n/dist\nignored.txt\n');
    await writeFile(join(root, 'src/app.ts'), 'const a = 1;\nexport const b = "needle";\nconst c = a + b.length;\n');
    await writeFile(join(root, 'src/debug.log'), 'needle in log\n');
    await writeFile(join(root, 'README.md'), 'needle here too\n');
    await writeFile(join(root, 'ignored.txt'), 'needle ignored\n');
    await writeFile(join(root, 'node_modules/pkg/index.js'), 'needle hidden\n');
    await writeFile(join(root, '.git/config'), '[core]\n');
    cleanup = () => rm(root, { recursive: true, force: true });
    process.on('exit', cleanup);
  });

  after(() => cleanup());

  describe('list_files', () => {
    it('lists files recursively while honouring gitignore and always-skip dirs', async () => {
      const tool = createListFilesTool({ root });
      const result = (await tool.execute({}, ctx)) as { files: string[]; truncated: boolean };
      assert.deepEqual(result.files.sort(), ['.gitignore', 'README.md', 'src/app.ts']);
      assert.equal(result.truncated, false);
    });

    it('truncates at maxEntries and flags it', async () => {
      const tool = createListFilesTool({ root, maxEntries: 1 });
      const result = (await tool.execute({}, ctx)) as { files: string[]; truncated: boolean };
      assert.equal(result.files.length, 1);
      assert.equal(result.truncated, true);
    });

    it('rejects missing options gracefully on empty dirs', async () => {
      const empty = await mkdtemp(join(tmpdir(), 'repo-empty-'));
      try {
        const tool = createListFilesTool({ root: empty });
        const result = (await tool.execute({}, ctx)) as { files: string[] };
        assert.deepEqual(result.files, []);
      } finally {
        await rm(empty, { recursive: true, force: true });
      }
    });
  });

  describe('read_file', () => {
    it('reads whole file with metadata', async () => {
      const tool = createReadFileTool({ root });
      const r = (await tool.execute({ path: 'src/app.ts' }, ctx)) as Record<string, unknown>;
      assert.equal(r.path, 'src/app.ts');
      assert.equal(r.totalLines, 3);
      assert.equal(r.startLine, 1);
      assert.equal(r.bytes, 64);
      assert.equal(r.truncated, false);
      assert.ok(String(r.content).includes('needle'));
    });

    it('supports offsetLine/maxLines windows', async () => {
      const tool = createReadFileTool({ root });
      const r = (await tool.execute({ path: 'src/app.ts', offsetLine: 2, maxLines: 1 }, ctx)) as Record<string, unknown>;
      assert.equal(r.startLine, 2);
      assert.equal(r.content, 'export const b = "needle";');
      assert.equal(r.totalLines, 3);
      assert.equal(r.truncated, true);
    });

    it('rejects path escape attempts', async () => {
      const tool = createReadFileTool({ root });
      await assert.rejects(tool.execute({ path: '../outside.txt' }, ctx), /escapes/);
      await assert.rejects(tool.execute({ path: '/etc/passwd' }, ctx));
    });

    it('enforces the byte cap', async () => {
      const big = join(root, 'big.bin');
      await writeFile(big, Buffer.alloc(4096, 65).toString('utf8').repeat(64)); // 256 KiB
      const tool = createReadFileTool({ root, maxBytes: 1024 });
      const r = (await tool.execute({ path: 'big.bin' }, ctx)) as Record<string, unknown>;
      assert.equal(r.bytes, 1024);
      assert.equal(r.truncated, true);
      await rm(big);
    });
  });

  describe('search_text', () => {
    it('finds literal matches skipping ignored files', async () => {
      const tool = createSearchTextTool({ root });
      const r = (await tool.execute({ pattern: 'needle' }, ctx)) as { matches: Array<{ path: string; line: number; text: string }>; truncated: boolean };
      const paths = r.matches.map((m) => `${m.path}:${m.line}`).sort();
      assert.deepEqual(paths, ['README.md:1', 'src/app.ts:2']);
      assert.equal(r.truncated, false);
    });

    it('supports regex mode with line numbers', async () => {
      const tool = createSearchTextTool({ root });
      const r = (await tool.execute({ pattern: 'b\\.length', isRegex: true }, ctx)) as { matches: Array<{ path: string; line: number }> };
      assert.deepEqual(r.matches.map((m) => [m.path, m.line]), [['src/app.ts', 3]]);
    });

    it('respects case sensitivity flag', async () => {
      const tool = createSearchTextTool({ root });
      const ci = (await tool.execute({ pattern: 'NEEDLE', caseSensitive: false }, ctx)) as { matches: unknown[] };
      const cs = (await tool.execute({ pattern: 'NEEDLE', caseSensitive: true }, ctx)) as { matches: unknown[] };
      assert.ok(ci.matches.length > 0);
      assert.equal(cs.matches.length, 0);
    });

    it('filters by glob', async () => {
      const tool = createSearchTextTool({ root });
      const r = (await tool.execute({ pattern: 'needle', glob: '*.md' }, ctx)) as { matches: Array<{ path: string }> };
      assert.deepEqual(r.matches.map((m) => m.path), ['README.md']);
    });

    it('honours per-call maxResults and truncation flag', async () => {
      const tool = createSearchTextTool({ root });
      const r = (await tool.execute({ pattern: 'needle', maxResults: 1 }, ctx)) as { matches: unknown[]; truncated: boolean };
      assert.equal(r.matches.length, 1);
      assert.equal(r.truncated, true);
    });

    it('reports invalid regex as a clean error', async () => {
      const tool = createSearchTextTool({ root });
      await assert.rejects(
        tool.execute({ pattern: '([unclosed', isRegex: true }, ctx),
        /Invalid search pattern/,
      );
    });
  });
});
