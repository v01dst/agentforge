import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { defineTool } from './tool.js';

const runFile = promisify(execFile);

export interface ApplyPatchToolOptions { root: string; allowWrite: boolean; }
export interface GitDiffToolOptions { root: string; }

type HunkLineKind = 'context' | 'add' | 'del';
interface HunkLine { kind: HunkLineKind; text: string; }
interface Hunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: HunkLine[]; }
interface FilePatch { path: string; hunks: Hunk[]; }

/** Parse a minimal unified diff: ---/+++ headers, @@ hunks, context/+/- lines. */
function parsePatches(patch: string): FilePatch[] {
  const lines = patch.split('\n').map((line) => line.replace(/\r$/, ''));
  const patches: FilePatch[] = [];
  let current: FilePatch | null = null;
  let hunk: Hunk | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('--- ')) { if (current?.path) patches.push(current); current = { path: '', hunks: [] }; hunk = null; continue; }
    if (line.startsWith('+++ ')) {
      if (!current) throw new Error(`Malformed patch: '+++' header without '---' header at line ${i + 1}`);
      let raw = line.slice(4).trim();
      const tab = raw.indexOf('\t');
      if (tab >= 0) raw = raw.slice(0, tab);
      raw = raw.replace(/^[ab]\//, '');
      if (!raw || raw === '/dev/null') throw new Error(`Missing target file path in patch at line ${i + 1}`);
      current.path = raw;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!current?.path) throw new Error(`Hunk header without a target file at line ${i + 1}`);
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) throw new Error(`Malformed hunk header at line ${i + 1}: ${line}`);
      hunk = {
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      };
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk || !current?.path) {
      if (line === '' || line.startsWith('\\')) continue;
      if (/^(diff |index |new file mode|deleted file mode|similarity |rename )/.test(line)) continue;
      if (line.trim() !== '') throw new Error(`Unexpected line outside a hunk at line ${i + 1}: ${line.slice(0, 40)}`);
      continue;
    }
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) { hunk.lines.push({ kind: 'add', text: line.slice(1) }); continue; }
    if (line.startsWith('-')) { hunk.lines.push({ kind: 'del', text: line.slice(1) }); continue; }
    if (line.startsWith(' ') || line === '') { hunk.lines.push({ kind: 'context', text: line.slice(1) }); continue; }
    throw new Error(`Unexpected line inside hunk at line ${i + 1}: ${line.slice(0, 40)}`);
  }
  if (current?.path) patches.push(current);

  for (const file of patches) {
    if (!file.path) throw new Error('Patch contains a file section without a target path');
    if (!file.hunks.length) throw new Error(`Patch contains no hunks for file ${file.path}`);
  }
  return patches;
}

/** Apply parsed hunks to original content; throws when any hunk fails to apply. */
function applyHunksToContent(original: string, hunks: Hunk[], path: string): string {
  const source = original.split('\n');
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const hunkStart = hunk.oldStart === 0 && hunk.oldLines === 0 ? source.length : hunk.oldStart - 1;
    if (hunkStart < cursor || hunkStart > source.length) throw new Error(`Hunk for ${path} does not apply cleanly`);
    while (cursor < hunkStart) { out.push(source[cursor]!); cursor++; }
    for (const entry of hunk.lines) {
      if (entry.kind === 'context') {
        if ((source[cursor] ?? '') !== entry.text) throw new Error(`Hunk for ${path} does not apply cleanly: context mismatch near line ${cursor + 1}`);
        out.push(entry.text); cursor++;
      } else if (entry.kind === 'del') {
        if ((source[cursor] ?? '') !== entry.text) throw new Error(`Hunk for ${path} does not apply cleanly: deletion mismatch near line ${cursor + 1}`);
        cursor++;
      } else {
        out.push(entry.text);
      }
    }
  }
  while (cursor < source.length) { out.push(source[cursor]!); cursor++; }
  return out.join('\n');
}

function safePathUnder(root: string, value: string): string {
  if (value.includes('\0')) throw new Error(`Invalid path in patch: ${JSON.stringify(value)}`);
  const full = resolve(root, value);
  const rel = relative(root, full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path escapes the configured workspace root: ${value}`);
  return full;
}

interface DiffOp { kind: 'ctx' | 'add' | 'del'; text: string; }

/** Small LCS-based line differ producing a unified diff string. */
function unifiedDiffOf(original: string, updated: string, path: string): string {
  const a = original.split('\n');
  const b = updated.split('\n');
  const m = a.length; const n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0; let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { ops.push({ kind: 'ctx', text: a[i]! }); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { ops.push({ kind: 'del', text: a[i]! }); i++; }
    else { ops.push({ kind: 'add', text: b[j]! }); j++; }
  }
  while (i < m) { ops.push({ kind: 'del', text: a[i]! }); i++; }
  while (j < n) { ops.push({ kind: 'add', text: b[j]! }); j++; }

  const body: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let k = 0;
  let added = 0;
  let removed = 0;
  while (k < ops.length) {
    if (ops[k]!.kind === 'ctx') { k++; continue; }
    // Include up to 3 leading context lines.
    let start = k;
    let leadCtx = 0;
    while (start > 0 && ops[start - 1]!.kind === 'ctx' && leadCtx < 3) { start--; leadCtx++; }
    // Extend through changes separated by fewer than 3 context lines, then trailing context.
    let end = start;
    let ctxRun = 0;
    while (end < ops.length) {
      const op = ops[end]!;
      if (op.kind === 'ctx') { ctxRun++; end++; if (ctxRun >= 3) break; }
      else { ctxRun = 0; end++; }
    }
    const slice = ops.slice(start, end);
    let oldIdx = 1; let newIdx = 1;
    for (const op of ops.slice(0, start)) {
      if (op.kind === 'add') newIdx++;
      else if (op.kind === 'del') oldIdx++;
      else { oldIdx++; newIdx++; }
    }
    let oldCount = 0; let newCount = 0;
    for (const op of slice) {
      if (op.kind === 'add') newCount++;
      else if (op.kind === 'del') oldCount++;
      else { oldCount++; newCount++; }
    }
    body.push(`@@ -${oldIdx},${oldCount} +${newIdx},${newCount} @@`);
    for (const op of slice) body.push((op.kind === 'add' ? '+' : op.kind === 'del' ? '-' : ' ') + op.text);
    for (const op of slice) { if (op.kind === 'add') added++; else if (op.kind === 'del') removed++; }
    k = end;
  }
  void added; void removed;
  return `${body.join('\n')}\n`;
}

export function createApplyPatchTool(options: ApplyPatchToolOptions) {
  const root = resolve(options.root);
  return defineTool({
    name: 'apply_patch',
    description: 'Apply a unified diff patch to files under the workspace root. All hunks are validated before any write; dry-run by default.',
    permissions: options.allowWrite ? ['filesystem:read', 'filesystem:write'] : ['filesystem:read'],
    input: z.object({ patch: z.string(), dryRun: z.boolean().default(true) }),
    output: z.object({
      applied: z.boolean(),
      dryRun: z.boolean(),
      files: z.array(z.object({ path: z.string(), added: z.number(), removed: z.number() })),
      diff: z.string(),
    }),
    async execute(input) {
      const patches = parsePatches(input.patch);
      if (!patches.length) throw new Error('Patch contains no file sections');
      const prepared: Array<{ path: string; absolutePath: string; added: number; removed: number; original: string; updated: string }> = [];
      for (const filePatch of patches) {
        const absolutePath = safePathUnder(root, filePatch.path);
        let original: string;
        try { original = await readFile(absolutePath, 'utf8'); } catch { throw new Error(`Cannot read patched file under root: ${filePatch.path}`); }
        const updated = applyHunksToContent(original, filePatch.hunks, filePatch.path);
        let added = 0; let removed = 0;
        for (const hunk of filePatch.hunks) for (const line of hunk.lines) { if (line.kind === 'add') added++; else if (line.kind === 'del') removed++; }
        prepared.push({ path: filePatch.path, absolutePath, added, removed, original, updated });
      }
      const diff = prepared.map((p) => unifiedDiffOf(p.original, p.updated, p.path)).join('');
      const files = prepared.map(({ path, added, removed }) => ({ path, added, removed }));
      if (input.dryRun) return { applied: false, dryRun: true, files, diff };
      if (!options.allowWrite) throw new Error('apply_patch writes are disabled (allowWrite=false)');
      // Validate-all-then-write: hunks were already applied in memory above; only writes happen here.
      for (const item of prepared) await writeFile(item.absolutePath, item.updated, 'utf8');
      return { applied: true, dryRun: false, files, diff };
    },
  });
}

export function createGitDiffTool(options: GitDiffToolOptions) {
  const root = resolve(options.root);
  return defineTool({
    name: 'inspect_git_diff',
    description: 'Read-only git inspection: porcelain status plus working-tree (or staged) diff for the repository rooted at the configured directory.',
    permissions: ['process:execute'],
    input: z.object({ staged: z.boolean().default(false) }),
    output: z.object({ isRepo: z.boolean(), status: z.string(), diff: z.string() }),
    async execute(input) {
      try {
        const statusResult = await runFile('git', ['status', '--porcelain'], { cwd: root, maxBuffer: 10_000_000 });
        const diffResult = await runFile('git', input.staged ? ['diff', '--cached'] : ['diff'], { cwd: root, maxBuffer: 10_000_000 });
        return { isRepo: true, status: statusResult.stdout, diff: diffResult.stdout };
      } catch (error) {
        const value = error as Error & { stderr?: string; code?: number };
        const message = `${value.stderr ?? ''} ${value.message}`;
        if (/not a git repository/i.test(message)) throw new Error(`Not a git repository: ${root}`);
        throw new Error(`git failed (${value.code ?? 'unknown'}): ${(value.stderr ?? value.message).trim()}`);
      }
    },
  });
}
