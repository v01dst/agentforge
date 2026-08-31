import { mkdir, readFile, readdir, unlink, appendFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AgentEvent, EventSink } from '@agentforge-oss/core';

/**
 * Observability core (Phase Q): a local-first, NDJSON event sink under
 * `.agentforge/observability/`. Doctrine: "model-visible means logged" —
 * every event the agent produces (model calls, tool executions, workflow
 * steps) lands in an append-only per-run log. No telemetry leaves the
 * machine; nothing here gates execution (pure observation).
 *
 * Files: `runs/<runId>.ndjson` (one JSON object per event) and
 * `index.ndjson` (one line per run: runId, startedAt, type counts, status).
 */

export const OBSERVABILITY_DIR = '.agentforge/observability';
export const RUNS_SUBDIR = 'runs';
export const INDEX_FILE = 'index.ndjson';

export function observabilityDir(cwd = process.cwd()): string {
  return join(resolve(cwd), OBSERVABILITY_DIR);
}

export function runLogPath(runId: string, cwd = process.cwd()): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(runId)) throw new Error(`Invalid run id: ${runId}`);
  return join(observabilityDir(cwd), RUNS_SUBDIR, `${runId}.ndjson`);
}

export function indexPath(cwd = process.cwd()): string {
  return join(observabilityDir(cwd), INDEX_FILE);
}

/** Aggregate one run's event types into the index line. */
export interface RunIndexEntry {
  runId: string;
  startedAt: string;
  endedAt?: string;
  status: 'running' | 'completed' | 'failed';
  counts: Record<string, number>;
}

export class ObservabilitySink implements EventSink {
  private readonly indexCounts = new Map<string, Record<string, number>>();
  private readonly startedAt = new Map<string, string>();

  constructor(private readonly cwd: string) {}

  async emit(event: AgentEvent): Promise<void> {
    await this.ensureDirs();
    await appendFile(runLogPath(event.runId, this.cwd), `${JSON.stringify(event)}\n`, 'utf8');
    const counts = this.indexCounts.get(event.runId) ?? {};
    counts[event.type] = (counts[event.type] ?? 0) + 1;
    this.indexCounts.set(event.runId, counts);
    if (!this.startedAt.has(event.runId)) this.startedAt.set(event.runId, event.timestamp);
    await this.writeIndexLine(event);
  }

  private async writeIndexLine(event: AgentEvent): Promise<void> {
    const status: RunIndexEntry['status'] = event.type === 'agent.completed'
      ? 'completed'
      : event.type === 'agent.failed'
        ? 'failed'
        : 'running';
    const entry: RunIndexEntry = {
      runId: event.runId,
      startedAt: this.startedAt.get(event.runId) ?? event.timestamp,
      status,
      counts: this.indexCounts.get(event.runId) ?? {},
    };
    if (status !== 'running') entry.endedAt = event.timestamp;
    await appendFile(indexPath(this.cwd), `${JSON.stringify(entry)}\n`, 'utf8');
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(join(observabilityDir(this.cwd), RUNS_SUBDIR), { recursive: true });
  }
}

/**
 * Bound a run's index to its latest line: rebuild a compact index by taking
 * the last entry per runId, ordered by startedAt.
 */
export function compactIndex(raw: string): RunIndexEntry[] {
  const latest = new Map<string, RunIndexEntry>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as RunIndexEntry;
      if (typeof parsed.runId !== 'string' || typeof parsed.status !== 'string') continue;
      latest.set(parsed.runId, parsed);
    } catch {
      continue;
    }
  }
  return [...latest.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** Read the compacted run index (newest first). */
export async function readRunIndex(cwd = process.cwd(), limit = 50): Promise<RunIndexEntry[]> {
  try {
    const raw = await readFile(indexPath(cwd), 'utf8');
    return compactIndex(raw).reverse().slice(0, limit);
  } catch {
    return [];
  }
}

/** Read one run's full event log; missing run yields undefined. */
export async function readRunEvents(runId: string, cwd = process.cwd()): Promise<AgentEvent[] | undefined> {
  try {
    const raw = await readFile(runLogPath(runId, cwd), 'utf8');
    const events: AgentEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as AgentEvent;
        if (typeof parsed.type === 'string' && typeof parsed.runId === 'string' && typeof parsed.timestamp === 'string') {
          events.push(parsed);
        }
      } catch {
        continue;
      }
    }
    return events;
  } catch {
    return undefined;
  }
}

/** A text summary of one run for humans: status, counts, first/last events. */
export function summarizeRunEvents(events: readonly AgentEvent[]): string {
  if (!events.length) return '(no events)';
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  const last = events[events.length - 1]!;
  const status = last.type === 'agent.completed' ? 'completed' : last.type === 'agent.failed' ? 'failed' : 'running';
  const durationMs = Date.parse(last.timestamp) - Date.parse(events[0]!.timestamp);
  const lines = [
    `run ${events[0]!.runId} — ${status} · ${events.length} events · ${(durationMs / 1000).toFixed(1)}s`,
    ...Object.entries(counts).map(([type, count]) => `  ${type}: ${count}`),
  ];
  let failedTool: AgentEvent | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.type === 'tool.failed') { failedTool = events[index]; break; }
  }
  if (failedTool) lines.push(`  last tool failure: ${JSON.stringify(failedTool.data).slice(0, 160)}`);
  return lines.join('\n');
}

/** Retention: drop run logs whose last update is older than the cutoff days. */
export async function pruneObservability(olderThanDays: number, cwd = process.cwd()): Promise<string[]> {
  const runsDir = join(observabilityDir(cwd), RUNS_SUBDIR);
  let files: string[];
  try {
    files = await readdir(runsDir);
  } catch {
    return [];
  }
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  for (const file of files.filter((entry) => entry.endsWith('.ndjson'))) {
    const path = join(runsDir, file);
    try {
      const info = await stat(path);
      if (info.mtimeMs < cutoff) {
        await unlink(path).catch(() => {});
        removed.push(file.replace(/\.ndjson$/, ''));
      }
    } catch {
      continue;
    }
  }
  return removed;
}
