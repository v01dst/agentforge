import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { platform } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { ToolLike } from '@agentforge-oss/core';

/**
 * Device tools (Phase M): desktop-integration utilities — notifications,
 * opening URLs, clipboard access, and screenshots. Platform-aware command
 * builders (darwin / linux / win32); every tool fails honestly when the
 * platform utility is unavailable instead of guessing.
 *
 * Permission model: all device tools carry `process:execute` — they shell
 * out to platform utilities, so the existing policy layer (ask prompts,
 * trusted auto-allow) applies unchanged. One policy layer.
 */

export type DevicePlatform = 'darwin' | 'linux' | 'win32' | 'unsupported';

export function devicePlatform(platformName: string = platform()): DevicePlatform {
  if (platformName === 'darwin' || platformName === 'linux' || platformName === 'win32') return platformName;
  return 'unsupported';
}

export interface ShellCommand {
  command: string;
  args: string[];
}

/** macOS notification via AppleScript (no external deps). */
export function notifyCommand(platformName: DevicePlatform, title: string, message: string): ShellCommand | undefined {
  switch (platformName) {
    case 'darwin':
      return { command: 'osascript', args: ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`] };
    case 'linux':
      return { command: 'notify-send', args: [title, message] };
    case 'win32':
      return { command: 'powershell', args: ['-NoProfile', '-Command', `[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; [System.Windows.Forms.MessageBox]::Show(${JSON.stringify(message)}, ${JSON.stringify(title)})`] };
    default:
      return undefined;
  }
}

export function openUrlCommand(platformName: DevicePlatform, url: string): ShellCommand | undefined {
  switch (platformName) {
    case 'darwin':
      return { command: 'open', args: [url] };
    case 'linux':
      return { command: 'xdg-open', args: [url] };
    case 'win32':
      return { command: 'cmd', args: ['/c', 'start', '', url] };
    default:
      return undefined;
  }
}

export function clipboardWriteCommand(platformName: DevicePlatform, text: string): ShellCommand | undefined {
  switch (platformName) {
    case 'darwin':
      return { command: 'pbcopy', args: [] };
    case 'linux':
      return { command: 'wl-copy', args: [] };
    case 'win32':
      return { command: 'powershell', args: ['-NoProfile', '-Command', `Set-Clipboard -Value ${JSON.stringify(text)}`] };
    default:
      return undefined;
  }
}

export function clipboardReadCommand(platformName: DevicePlatform): ShellCommand | undefined {
  switch (platformName) {
    case 'darwin':
      return { command: 'pbpaste', args: [] };
    case 'linux':
      return { command: 'wl-paste', args: [] };
    case 'win32':
      return { command: 'powershell', args: ['-NoProfile', '-Command', 'Get-Clipboard'] };
    default:
      return undefined;
  }
}

export function screenshotCommand(platformName: DevicePlatform, outputPath: string): ShellCommand | undefined {
  switch (platformName) {
    case 'darwin':
      return { command: 'screencapture', args: ['-x', outputPath] };
    case 'linux':
      return { command: 'gnome-screenshot', args: ['-f', outputPath] };
    case 'win32':
      return { command: 'powershell', args: ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save(${JSON.stringify(outputPath)})`] };
    default:
      return undefined;
  }
}

function runShell(command: ShellCommand, input?: string, timeoutMs = 15_000): Promise<{ ok: boolean; stdout: string; error?: string }> {
  return new Promise((resolveRun) => {
    let child;
    try {
      child = spawn(command.command, command.args, { stdio: input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolveRun({ ok: false, stdout: '', error: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolveRun({ ok: false, stdout: '', error: error.code === 'ENOENT' ? `Utility '${command.command}' is not available on this machine.` : error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun({ ok: true, stdout });
      else resolveRun({ ok: false, stdout, error: stderr.trim() || `'${command.command}' exited with code ${code}` });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

export interface DeviceToolsOptions {
  /** Workspace root for screenshot storage (`.agentforge/screenshots/`). */
  root: string;
  platformName?: string;
}

export function createDeviceTools(options: DeviceToolsOptions): ToolLike[] {
  const platformName = devicePlatform(options.platformName);
  const screenshotsDir = join(resolve(options.root), '.agentforge', 'screenshots');

  const withPlatform = <T,>(build: (platformName: DevicePlatform) => T | undefined): T | { error: string } => {
    const built = build(platformName);
    if (built === undefined) return { error: `Device action is not supported on this platform (${platformName}).` };
    return built;
  };

  const notify: ToolLike = {
    name: 'device_notify',
    description: 'Send a desktop notification to the user (OS notification center). Use sparingly for milestones that need attention.',
    inputSchema: z.object({
      title: z.string().min(1).max(120).describe('Notification title.'),
      message: z.string().min(1).max(500).describe('Notification body.'),
    }),
    permissions: ['process:execute'],
    async execute(input) {
      const parsed = input as { title: string; message: string };
      const command = withPlatform((platformValue) => notifyCommand(platformValue, parsed.title, parsed.message));
      if ('error' in command) return { ok: false, error: command.error };
      void command;
      const result = await runShell(command);
      return result.ok ? { ok: true, delivered: true } : { ok: false, error: result.error };
    },
  };

  const openUrl: ToolLike = {
    name: 'device_open_url',
    description: 'Open a URL in the default browser of this machine.',
    inputSchema: z.object({
      url: z.string().url().max(2000).describe('The URL to open (http/https).'),
    }),
    permissions: ['process:execute'],
    async execute(input) {
      const parsed = input as { url: string };
      if (!/^https?:\/\//i.test(parsed.url)) return { ok: false, error: 'Only http(s) URLs can be opened.' };
      const command = withPlatform((platformValue) => openUrlCommand(platformValue, parsed.url));
      if ('error' in command) return { ok: false, error: command.error };
      void command;
      const result = await runShell(command);
      return result.ok ? { ok: true, opened: parsed.url } : { ok: false, error: result.error };
    },
  };

  const clipboardWrite: ToolLike = {
    name: 'device_clipboard_write',
    description: 'Copy text to the system clipboard.',
    inputSchema: z.object({
      text: z.string().min(1).max(100_000).describe('Text to place on the clipboard.'),
    }),
    permissions: ['process:execute'],
    async execute(input) {
      const parsed = input as { text: string };
      const command = withPlatform((platformValue) => clipboardWriteCommand(platformValue, parsed.text));
      if ('error' in command) return { ok: false, error: command.error };
      void command;
      const result = await runShell(command, command.command === 'pbcopy' || command.command === 'wl-copy' ? parsed.text : undefined);
      return result.ok ? { ok: true, copied: parsed.text.length } : { ok: false, error: result.error };
    },
  };

  const clipboardRead: ToolLike = {
    name: 'device_clipboard_read',
    description: 'Read the current text content of the system clipboard.',
    inputSchema: z.object({}),
    permissions: ['process:execute'],
    async execute() {
      const command = withPlatform(clipboardReadCommand);
      if ('error' in command) return { ok: false, error: command.error };
      void command;
      const result = await runShell(command);
      return result.ok ? { ok: true, text: result.stdout } : { ok: false, error: result.error };
    },
  };

  const screenshot: ToolLike = {
    name: 'device_screenshot',
    description: 'Capture the screen to .agentforge/screenshots/ and return the saved path. Local-first: the image stays on this machine.',
    inputSchema: z.object({
      name: z.string().max(80).optional().describe('Optional file name (without extension).'),
    }),
    permissions: ['process:execute'],
    async execute(input) {
      const parsed = (input ?? {}) as { name?: string };
      await mkdir(screenshotsDir, { recursive: true });
      const safeName = (parsed.name ?? `screen-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '-');
      const ext = platformName === 'win32' ? 'png' : 'png';
      const outputPath = join(screenshotsDir, `${safeName}.${ext}`);
      const command = withPlatform((platformValue) => screenshotCommand(platformValue, outputPath));
      if ('error' in command) return { ok: false, error: command.error };
      void command;
      const result = await runShell(command, undefined, 20_000);
      return result.ok ? { ok: true, path: outputPath } : { ok: false, error: result.error };
    },
  };

  return [notify, openUrl, clipboardWrite, clipboardRead, screenshot];
}
