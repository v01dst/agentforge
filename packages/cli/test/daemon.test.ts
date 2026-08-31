import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  daemonPaths,
  heartbeatIsFresh,
  launchdPlabel,
  launchdPlist,
  readHeartbeat,
  runDaemon,
  systemdUnit,
} from '../src/daemon/daemon.js';
import type { TurnRunner } from '../src/ui/turn.js';

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'af-daemon-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const echoRunner: TurnRunner = async function* (input) {
  yield { text: `done:${input}` };
};

const failingRunner: TurnRunner = async function* (input) {
  yield { text: '' };
  throw new Error(`job exploded: ${input}`);
};

async function dropJob(root: string, id: string, body: Record<string, unknown>): Promise<void> {
  const paths = daemonPaths(root);
  await mkdir(paths.jobs, { recursive: true });
  await writeFile(join(paths.jobs, `${id}.json`), JSON.stringify(body), 'utf8');
}

test('daemon beats, drains jobs, writes results, and stops on the stop file', async () => {
  await withTemp(async (root) => {
    await dropJob(root, 'j1', { id: 'j1', type: 'prompt', text: 'say hi' });
    // Stop on the second beat.
    setTimeout(() => {
      void writeFile(daemonPaths(root).stop, 'now\n', 'utf8').catch(() => {});
    }, 30);
    const result = await runDaemon({ runner: echoRunner, cwd: root, intervalMs: 20, maxLoops: 2 });
    assert.ok(result.beats >= 1 && result.beats <= 2, `beats within 1..2 (got ${result.beats})`);
    assert.equal(result.jobsProcessed, 1);
    assert.equal(result.jobsFailed, 0);
    const resultBody = JSON.parse(await readFile(join(daemonPaths(root).out, 'j1.result.json'), 'utf8')) as { ok: boolean; output: string };
    assert.equal(resultBody.ok, true);
    assert.equal(resultBody.output, 'done:say hi');
    const jobsLeft = await readdir(daemonPaths(root).jobs);
    assert.equal(jobsLeft.length, 0, 'drained jobs are removed');
    const heartbeat = await readHeartbeat(root);
    assert.ok(heartbeat);
    assert.equal(heartbeat!.beats, result.beats);
  });
});

test('maxLoops bounds the loop deterministically', async () => {
  await withTemp(async (root) => {
    const result = await runDaemon({ runner: echoRunner, cwd: root, intervalMs: 5, maxLoops: 3 });
    assert.equal(result.beats, 3);
  });
});

test('failing jobs are counted and their errors land in result files', async () => {
  await withTemp(async (root) => {
    await dropJob(root, 'boom', { id: 'boom', type: 'prompt', text: 'break' });
    setTimeout(() => {
      void writeFile(daemonPaths(root).stop, 'now\n', 'utf8').catch(() => {});
    }, 30);
    const result = await runDaemon({ runner: failingRunner, cwd: root, intervalMs: 20, maxLoops: 2 });
    assert.equal(result.jobsFailed, 1);
    const resultBody = JSON.parse(await readFile(join(daemonPaths(root).out, 'boom.result.json'), 'utf8')) as { ok: boolean; error: string };
    assert.equal(resultBody.ok, false);
    assert.match(resultBody.error, /job exploded/);
  });
});

test('malformed job files fail loudly without killing the daemon', async () => {
  await withTemp(async (root) => {
    await dropJob(root, 'broken', { id: 'broken', type: 'nope' });
    setTimeout(() => {
      void writeFile(daemonPaths(root).stop, 'now\n', 'utf8').catch(() => {});
    }, 30);
    const result = await runDaemon({ runner: echoRunner, cwd: root, intervalMs: 20, maxLoops: 2 });
    assert.equal(result.jobsFailed, 1);
    const resultBody = JSON.parse(await readFile(join(daemonPaths(root).out, 'broken.json.result.json'), 'utf8')) as { ok: boolean; error: string };
    assert.match(resultBody.error, /Malformed daemon job file/);
  });
});

test('heartbeat freshness detection', async () => {
  const fresh = { pid: 1, startedAt: '2026-08-31T00:00:00Z', lastBeat: new Date(Date.now() - 1000).toISOString(), beats: 3, jobsProcessed: 0, jobsFailed: 0 };
  const stale = { ...fresh, lastBeat: new Date(Date.now() - 10 * 60 * 1000).toISOString() };
  assert.equal(heartbeatIsFresh(fresh), true);
  assert.equal(heartbeatIsFresh(stale), false);
  assert.equal(await readHeartbeat(join(tmpdir())), undefined, 'missing heartbeat is undefined');
});

test('supervised install templates: launchd label/plist and systemd unit', () => {
  const label = launchdPlabel('My Project!');
  assert.equal(label, 'oss.agentforge.daemon.My-Project-');
  const plist = launchdPlist(label, '/usr/bin/node', '/app/bin/agentforge', '/app');
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<string>daemon<\/string>/);
  assert.match(plist, /<string>\/app<\/string>/);
  const unit = systemdUnit('/app', '/app/bin/agentforge');
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /ExecStart=\/usr\/bin\/env node \/app\/bin\/agentforge daemon run/);
});
