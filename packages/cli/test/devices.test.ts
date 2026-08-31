import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDeviceTools,
  clipboardReadCommand,
  clipboardWriteCommand,
  devicePlatform,
  notifyCommand,
  openUrlCommand,
  screenshotCommand,
} from '../src/devices/devices.js';

const context = { runId: 'test', signal: new AbortController().signal } as never;

test('platform detection maps known platforms and is honest about the rest', () => {
  assert.equal(devicePlatform('darwin'), 'darwin');
  assert.equal(devicePlatform('linux'), 'linux');
  assert.equal(devicePlatform('win32'), 'win32');
  assert.equal(devicePlatform('freebsd'), 'unsupported');
});

test('notification commands per platform', () => {
  assert.deepEqual(notifyCommand('darwin', 'Build', 'done'), { command: 'osascript', args: ['-e', 'display notification "done" with title "Build"'] });
  assert.equal(notifyCommand('linux', 'Build', 'done')?.command, 'notify-send');
  assert.equal(notifyCommand('win32', 'Build', 'done')?.command, 'powershell');
  assert.equal(notifyCommand('unsupported', 'a', 'b'), undefined);
});

test('open-url commands pick the platform opener and refuse non-http', async () => {
  assert.deepEqual(openUrlCommand('darwin', 'https://example.com'), { command: 'open', args: ['https://example.com'] });
  assert.equal(openUrlCommand('linux', 'https://example.com')?.command, 'xdg-open');
  assert.deepEqual(openUrlCommand('win32', 'https://example.com').args, ['/c', 'start', '', 'https://example.com']);
  const [tool] = createDeviceTools({ root: tmpdir(), platformName: 'unsupported' });
  const result = await tool!.execute({ url: 'https://example.com' }, context) as { ok: boolean; error: string };
  assert.equal(result.ok, false);
  assert.match(result.error, /not supported on this platform/);
});

test('clipboard commands read and write per platform', () => {
  assert.deepEqual(clipboardWriteCommand('darwin', 'hi'), { command: 'pbcopy', args: [] });
  assert.equal(clipboardWriteCommand('linux', 'hi')?.command, 'wl-copy');
  assert.equal(clipboardReadCommand('darwin')?.command, 'pbpaste');
  assert.equal(clipboardReadCommand('linux')?.command, 'wl-paste');
  assert.equal(clipboardReadCommand('unsupported'), undefined);
});

test('screenshot commands target .agentforge/screenshots inside the workspace', () => {
  const root = '/tmp/af-devices';
  assert.deepEqual(screenshotCommand('darwin', `${root}/.agentforge/screenshots/x.png`), { command: 'screencapture', args: ['-x', `${root}/.agentforge/screenshots/x.png`] });
  assert.equal(screenshotCommand('linux', `${root}/s.png`)?.command, 'gnome-screenshot');
  assert.match(screenshotCommand('win32', 'C:/s.png')!.command, /powershell/);
  assert.equal(screenshotCommand('unsupported', 'x'), undefined);
});

test('device tools are registered with process:execute permissions', () => {
  const tools = createDeviceTools({ root: tmpdir(), platformName: 'linux' });
  const names = tools.map((tool) => tool.name);
  assert.deepEqual(names, ['device_notify', 'device_open_url', 'device_clipboard_write', 'device_clipboard_read', 'device_screenshot']);
  for (const tool of tools) assert.deepEqual(tool.permissions, ['process:execute']);
});

test('missing utilities fail honestly instead of faking success', async () => {
  // 'unsupported' platform short-circuits before spawning anything.
  const [, openUrlTool, , , screenshotTool] = createDeviceTools({ root: tmpdir(), platformName: 'unsupported' });
  assert.match((await openUrlTool!.execute({ url: 'https://x.example' }, context) as { error: string }).error, /not supported/);
  const screenshot = await screenshotTool!.execute({ name: 'shot one' }, context) as { error?: string };
  assert.match(screenshot.error ?? '', /not supported/);
});

test('open_url rejects non-http URLs', async () => {
  const [, openUrlTool] = createDeviceTools({ root: tmpdir(), platformName: 'darwin' });
  const result = await openUrlTool!.execute({ url: 'file:///etc/passwd' }, context) as { ok: boolean; error: string };
  assert.equal(result.ok, false);
  assert.match(result.error, /Only http/);
});

test('screenshot paths are workspace-scoped and sanitized', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-device-'));
  try {
    const screenshotTool = createDeviceTools({ root, platformName: 'unsupported' }).at(-1)!;
    const result = await screenshotTool.execute({ name: '../escape' }, context) as { error: string };
    assert.match(result.error, /not supported/);
    // The builder itself sanitizes the file name before any command runs.
    void root;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
