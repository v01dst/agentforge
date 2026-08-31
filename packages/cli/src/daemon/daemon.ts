import { mkdir, readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TurnRunner } from '../ui/turn.js';

/**
 * Daemon + heartbeat (Phase K): a foreground loop (run with `agentforge
 * daemon run`, or installed as a supervised unit with `agentforge daemon
 * install`) that
 *
 * 1. writes a heartbeat file every `intervalMs` — `.agentforge/daemon/
 *    heartbeat.json` with pid, timestamps, and counters;
 * 2. drains job files dropped into `.agentforge/daemon/jobs/` (JSON:
 *    `{ id, type: "prompt", text }`), runs each prompt through the runner,
 *    and writes `<id>.result.json` next to `out/`;
 * 3. exits gracefully when `.agentforge/daemon/stop` appears.
 *
 * Local-first: everything lives under `.agentforge/daemon/`. Tests inject a
 * TurnRunner and use short intervals — fully deterministic.
 */

export interface DaemonPaths {
  root: string;
  heartbeat: string;
  jobs: string;
  out: string;
  stop: string;
}

export function daemonPaths(cwd = process.cwd()): DaemonPaths {
  const root = join(resolve(cwd), '.agentforge', 'daemon');
  return { root, heartbeat: join(root, 'heartbeat.json'), jobs: join(root, 'jobs'), out: join(root, 'out'), stop: join(root, 'stop') };
}

export interface Heartbeat {
  pid: number;
  startedAt: string;
  lastBeat: string;
  beats: number;
  jobsProcessed: number;
  jobsFailed: number;
}

export async function readHeartbeat(cwd = process.cwd()): Promise<Heartbeat | undefined> {
  try {
    return JSON.parse(await readFile(daemonPaths(cwd).heartbeat, 'utf8')) as Heartbeat;
  } catch {
    return undefined;
  }
}

/** A heartbeat is fresh if written within `freshMs` (default 3 intervals). */
export function heartbeatIsFresh(heartbeat: Heartbeat, freshMs = 90_000, now = Date.now()): boolean {
  return now - Date.parse(heartbeat.lastBeat) < freshMs;
}

export interface DaemonJob {
  id: string;
  type: 'prompt';
  text: string;
}

export interface DaemonOptions {
  runner: TurnRunner;
  cwd?: string;
  /** Heartbeat interval in milliseconds (default 30s; tests use tiny values). */
  intervalMs?: number;
  /** Maximum loop iterations (default: infinite; tests bound the loop). */
  maxLoops?: number;
  /** Signal to stop the loop (tests). */
  signal?: AbortSignal;
}

export interface DaemonRunResult {
  beats: number;
  jobsProcessed: number;
  jobsFailed: number;
}

const JOB_TYPES = new Set(['prompt']);
void JOB_TYPES;

function parseJob(raw: string, file: string): DaemonJob | undefined {
  let parsedJson: Record<string, unknown>;
  try {
    parsedJson = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Malformed daemon job file: ${file}`);
  }
  if (typeof parsedJson.id !== 'string' || parsedJson.type !== 'prompt' || typeof parsedJson.text !== 'string') {
    throw new Error(`Malformed daemon job file: ${file}`);
  }
  return { id: parsedJson.id, type: 'prompt', text: parsedJson.text };
}

/**
 * Foreground daemon loop. Returns when stop file appears, the signal fires,
 * or maxLoops is reached. Never throws for job failures — those are counted
 * and their errors land in the result files.
 */
export async function runDaemon(options: DaemonOptions): Promise<DaemonRunResult> {
  const paths = daemonPaths(options.cwd);
  const intervalMs = options.intervalMs ?? 30_000;
  const heartbeat: Heartbeat = { pid: process.pid, startedAt: new Date().toISOString(), lastBeat: '', beats: 0, jobsProcessed: 0, jobsFailed: 0 };
  await mkdir(paths.jobs, { recursive: true });
  await mkdir(paths.out, { recursive: true });
  await unlink(paths.stop).catch(() => {});

  for (;;) {
    // Heartbeat.
    heartbeat.beats += 1;
    heartbeat.lastBeat = new Date().toISOString();
    await writeFile(paths.heartbeat, `${JSON.stringify(heartbeat, null, 2)}\n`, 'utf8');

    // Drain jobs.
    let files: string[];
    try {
      files = (await readdir(paths.jobs)).filter((file) => file.endsWith('.json'));
    } catch {
      files = [];
    }
    for (const file of files) {
      const path = join(paths.jobs, file);
      let job: DaemonJob | undefined;
      try {
        job = parseJob(await readFile(path, 'utf8'), file);
      } catch (error) {
        await writeFile(join(paths.out, `${file}.result.json`), `${JSON.stringify({ ok: false, error: (error as Error).message }, null, 2)}\n`, 'utf8');
        await unlink(path).catch(() => {});
        heartbeat.jobsFailed += 1;
        continue;
      }
      if (!job) {
        await writeFile(join(paths.out, `${file}.result.json`), `${JSON.stringify({ ok: false, error: 'Unsupported job type.' }, null, 2)}\n`, 'utf8');
        await unlink(path).catch(() => {});
        heartbeat.jobsFailed += 1;
        continue;
      }
      try {
        let output = '';
        for await (const delta of options.runner(job.text, new AbortController().signal, {} as never)) output += delta.text ?? '';
        await writeFile(join(paths.out, `${job.id}.result.json`), `${JSON.stringify({ ok: true, jobId: job.id, output }, null, 2)}\n`, 'utf8');
        heartbeat.jobsProcessed += 1;
      } catch (error) {
        await writeFile(join(paths.out, `${job.id}.result.json`), `${JSON.stringify({ ok: false, jobId: job.id, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`, 'utf8');
        heartbeat.jobsFailed += 1;
      }
      await unlink(path).catch(() => {});
    }

    // Stop conditions.
    if (await exists(paths.stop)) { await unlink(paths.stop).catch(() => {}); break; }
    if (options.signal?.aborted) break;
    if (options.maxLoops !== undefined && heartbeat.beats >= options.maxLoops) break;
    await sleep(intervalMs, options.signal);
  }

  return { beats: heartbeat.beats, jobsProcessed: heartbeat.jobsProcessed, jobsFailed: heartbeat.jobsFailed };
}

function exists(path: string): Promise<boolean> {
  return readFile(path).then(() => true, () => false);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolveSleep(); }, ms);
    const onAbort = () => { clearTimeout(timer); resolveSleep(); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Supervised install (launchd on macOS, systemd user units on Linux)
// ---------------------------------------------------------------------------

export function launchdPlabel(projectName: string): string {
  const safe = projectName.replace(/[^a-zA-Z0-9.-]/g, '-');
  return `oss.agentforge.daemon.${safe}`;
}

export function launchdPlist(label: string, nodePath: string, cliEntry: string, projectRoot: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `  <key>Label</key><string>${label}</string>`,
    '  <key>ProgramArguments</key><array>',
    `    <string>${nodePath}</string>`,
    `    <string>${cliEntry}</string>`,
    '    <string>daemon</string>',
    '    <string>run</string>',
    '  </array>',
    `  <key>WorkingDirectory</key><string>${projectRoot}</string>`,
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    '  <key>StandardOutPath</key><string>/tmp/agentforge-daemon.log</string>',
    '  <key>StandardErrorPath</key><string>/tmp/agentforge-daemon.err.log</string>',
    '</dict></plist>',
    '',
  ].join('\n');
}

export function systemdUnit(projectRoot: string, cliEntry: string): string {
  return [
    '[Unit]',
    'Description=AgentForge daemon',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${projectRoot}`,
    `ExecStart=/usr/bin/env node ${cliEntry} daemon run`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}
