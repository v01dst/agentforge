import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { error, formatError, heading, hint, info, printJson, success, warn } from './output.js';
import { scaffold } from './project.js';
import type { AgentForgeConfig, NamedEntry, RunnableModule } from './types.js';

export const VERSION = '0.1.0';

export const HELP = `AgentForge ${VERSION}

Usage:
  agentforge <command> [options]

Commands:
  init <name|.>     Scaffold a local AgentForge project
  dev               Start the configured development process
  run <entry>       Execute an agent or workflow entrypoint
  chat <entry>      Start an interactive agent session
  test [patterns]   Run deterministic project tests
  inspect <run-id>  Inspect a persisted run
  providers         List configured model providers
  tools             List configured tools
  workflows         List configured workflows
  doctor            Check the local AgentForge project
  connect <provider> Configure a provider credential or endpoint

Global options:
  --help, -h        Show this help
  --version, -v     Show the CLI version
  --json            Emit machine-readable output where supported
  --cwd <path>      Run against a different project directory
`;

function flagBoolean(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === 'true';
}

function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

export async function importEntry(entry: string, context: { configPath?: string } = {}): Promise<RunnableModule> {
  const path = isAbsolute(entry) ? entry : resolve(process.cwd(), entry);
  try { await access(path, constants.R_OK); } catch {
    const lines = [
      `Entrypoint not found: ${entry}`,
      `  resolved: ${path}`,
    ];
    if (context.configPath) lines.push(`  config:   ${context.configPath}`);
    if (context.configPath) {
      const projectDir = dirname(context.configPath);
      if (resolve(process.cwd()) !== projectDir) lines.push(`The entrypoint resolves relative to the project directory containing the config file. Run from ${projectDir} or pass: agentforge --cwd ${projectDir} ...`);
      else lines.push(`Verify the 'entry' value in ${basename(context.configPath)} or scaffold with 'agentforge init .'.`);
    } else {
      lines.push(`No agentforge.config.ts was found; the entrypoint resolves relative to ${process.cwd()}. Run 'agentforge init .' here, or pass the path to an existing entrypoint.`);
    }
    throw new Error(lines.join('\n'));
  }
  const specifier = pathToFileURL(path).href;
  try {
    return await import(specifier) as RunnableModule;
  } catch (importError) {
    if (!path.endsWith('.ts') && !path.endsWith('.mts')) throw importError;
    const api = await import('tsx/esm/api') as unknown as { tsImport?: (value: string, parent?: string) => Promise<Record<string, unknown>> };
    if (!api.tsImport) throw importError;
    return await api.tsImport(specifier, import.meta.url) as RunnableModule;
  }
}

async function readInput(flags: Record<string, string | boolean>): Promise<string> {
  const explicit = flagString(flags, 'input');
  if (explicit !== undefined) return explicit;
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const input = Buffer.concat(chunks).toString('utf8').trim();
    if (input) return input;
  }
  return 'Hello from AgentForge';
}

function resolveRunnable(module: RunnableModule): (input: string) => Promise<unknown> {
  if (typeof module.run === 'function') return (input) => Promise.resolve(module.run?.(input));
  if (typeof module.default === 'function') return (input) => Promise.resolve((module.default as (value: string) => unknown)(input));
  if (module.agent && typeof module.agent.run === 'function') return (input) => Promise.resolve(module.agent?.run(input));
  if (module.workflow && typeof module.workflow.run === 'function') return (input) => Promise.resolve(module.workflow?.run(input));
  if (module.default && typeof module.default === 'object' && 'run' in module.default && typeof (module.default as { run?: unknown }).run === 'function') {
    return (input) => Promise.resolve((module.default as { run: (value: string) => unknown }).run(input));
  }
  throw new Error('Entrypoint must export run(), a default runnable, agent.run(), or workflow.run().');
}

function serializableResult(result: unknown): unknown {
  if (result && typeof result === 'object' && 'output' in result) return result;
  return { output: result };
}

export async function runCommand(entry: string | undefined, flags: Record<string, string | boolean>): Promise<number> {
  const { path: configPath, config } = await loadConfig();
  const selected = entry ?? config.entry;
  if (!selected) throw new Error('Missing entrypoint. Usage: agentforge run <entry> or set entry in agentforge.config.ts.');
  const input = await readInput(flags);
  const runnable = resolveRunnable(await importEntry(selected, { configPath }));
  const result = serializableResult(await runnable(input));
  if (flagBoolean(flags, 'json')) printJson(result); else {
    const output = result && typeof result === 'object' && 'output' in result ? (result as { output?: unknown }).output : result;
    info(typeof output === 'string' ? output : JSON.stringify(output, null, 2));
    if (result && typeof result === 'object' && 'runId' in result) hint(`run ${String((result as { runId: unknown }).runId)}`);
  }
  return 0;
}

/** Run a persistent terminal session with a local transcript. */
export async function chatCommand(entry: string | undefined, flags: Record<string, string | boolean>): Promise<number> {
  const { path: configPath, config } = await loadConfig();
  const selected = entry ?? config.entry;
  if (!selected) throw new Error('Missing entrypoint. Usage: agentforge chat <entry> or set entry in agentforge.config.ts.');
  const runnable = resolveRunnable(await importEntry(selected, { configPath }));
  const controller = new AbortController();
  const onInterrupt = () => { controller.abort(); info('\nSession cancelled.'); };
  process.once('SIGINT', onInterrupt);
  const rl = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
  const transcript: string[] = [];
  try {
    info('AgentForge chat. Type /help for commands, /exit to quit.');
    while (!controller.signal.aborted) {
      const input = (await rl.question('\nYou> ')).trim();
      if (!input) continue;
      if (input === '/exit' || input === '/quit') break;
      if (input === '/help') { info('Commands: /help, /connect <provider>, /providers, /status, /model <name>, /clear, /exit'); continue; }
      if (input === '/clear') { transcript.length = 0; info('Conversation cleared.'); continue; }
      if (input === '/providers') { await listCommand('providers', {}); continue; }
      if (input === '/status') { await doctorCommand({}); continue; }
      if (input.startsWith('/connect')) { const [, provider] = input.split(/\s+/, 2); await connectCommand(provider, { 'no-prompt': true }); continue; }
      if (input.startsWith('/model')) { const model = input.split(/\s+/, 2)[1]; if (!model) { info(`Current model: ${process.env.AGENTFORGE_MODEL ?? 'configured by project'}`); } else { process.env.AGENTFORGE_MODEL = model; info(`Model set for this session: ${model}`); } continue; }
      if (input.startsWith('/')) { warn(`Unknown command: ${input}. Type /help.`); continue; }
      transcript.push(`User: ${input}`);
      const result = serializableResult(await runnable(transcript.join('\n') + '\nAssistant:'));
      const output = result && typeof result === 'object' && 'output' in result ? (result as { output?: unknown }).output : result;
      const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
      transcript.push(`Assistant: ${text}`);
      info(`\nAgent> ${text}`);
    }
  } finally { rl.close(); process.removeListener('SIGINT', onInterrupt); }
  return 0;
}

function entryLabel(entry: string | NamedEntry): { name: string; description?: string } {
  return typeof entry === 'string' ? { name: entry } : { name: entry.name, description: entry.description };
}

export async function listCommand(kind: 'providers' | 'tools' | 'workflows', flags: Record<string, string | boolean>): Promise<number> {
  const { path, config } = await loadConfig();
  const entries = (config[kind] ?? []).map(entryLabel);
  if (flagBoolean(flags, 'json')) { printJson({ config: path, [kind]: entries }); return 0; }
  heading(kind.charAt(0).toUpperCase() + kind.slice(1));
  if (!entries.length) { hint(`No ${kind} configured${path ? ` in ${basename(path)}` : ''}.`); return 0; }
  for (const entry of entries) info(`  ${entry.name}${entry.description ? `  ${entry.description}` : ''}`);
  return 0;
}

async function findLocalRepoRoot(start = process.cwd()): Promise<string | undefined> {
  let current = resolve(start);
  while (true) {
    try {
      const packageJson = JSON.parse(await readFile(join(current, 'package.json'), 'utf8')) as { name?: string };
      await access(join(current, 'packages', 'core', 'package.json'), constants.R_OK);
      if (packageJson.name === 'agentforge') return current;
    } catch { /* continue walking */ }
    const parent = resolve(current, '..');
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function initCommand(name: string | undefined, flags: Record<string, string | boolean>): Promise<number> {
  if (!name) throw new Error('Missing project name. Usage: agentforge init <name>.');
  const explicitLocal = flagString(flags, 'local-root') ?? process.env.AGENTFORGE_REPO_ROOT;
  const localRoot = explicitLocal ?? (flagBoolean(flags, 'local') || !flagBoolean(flags, 'published') ? await findLocalRepoRoot() : undefined);
  if (flagBoolean(flags, 'local') && !localRoot) throw new Error('`agentforge init --local` requires --local-root <agentforge-repo> or AGENTFORGE_REPO_ROOT.');
  const target = await scaffold(name, process.cwd(), flagBoolean(flags, 'force'), localRoot);
  success(`Created ${target}`);
  const install = localRoot ? 'pnpm install' : 'npm install';
  const runner = localRoot ? 'pnpm exec agentforge' : 'npx agentforge';
  hint(`Next: cd ${name === '.' ? '.' : name} && ${install} && ${runner} chat`);
  return 0;
}

async function spawnAndForward(command: string, args: string[], env?: Record<string, string>): Promise<number> {
  return await new Promise<number>((resolveExit, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...env }, shell: false });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.once('SIGINT', forward); process.once('SIGTERM', forward);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      process.removeListener('SIGINT', forward); process.removeListener('SIGTERM', forward);
      resolveExit(code ?? (signal ? 1 : 0));
    });
  });
}

function commandParts(command: string | readonly string[]): [string, string[]] {
  if (typeof command !== 'string') { const [first, ...rest] = command; if (!first) throw new Error('dev.command cannot be empty.'); return [first, [...rest]]; }
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part: string) => part.replace(/^['"]|['"]$/g, '')) ?? [];
  const [first, ...rest] = parts; if (!first) throw new Error('dev.command cannot be empty.'); return [first, rest];
}

export async function devCommand(flags: Record<string, string | boolean>): Promise<number> {
  const { config } = await loadConfig();
  let command: string | readonly string[] | undefined = config.dev?.command;
  if (!command) {
    command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    const args = ['--filter', '@agentforge/playground', 'dev'];
    info('Starting the AgentForge playground...');
    return await spawnAndForward(command, args, config.dev?.env);
  }
  const [binary, args] = commandParts(command);
  if (flagBoolean(flags, 'open')) args.push('--open');
  return await spawnAndForward(binary, args, config.dev?.env);
}

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const path of paths) { try { await access(path, constants.R_OK); return path; } catch { /* continue */ } }
  return undefined;
}

export async function testCommand(patterns: string[]): Promise<number> {
  const selected = patterns.length ? patterns : await firstExisting(['test', 'tests']) ? ['test'] : [];
  if (!selected.length) { warn('No test or tests directory found.'); return 0; }
  const args = ['--test', ...selected];
  const binary = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return await spawnAndForward(binary, ['tsx', ...args]);
}

export async function doctorCommand(flags: Record<string, string | boolean>): Promise<number> {
  const { path, config } = await loadConfig({ required: false });
  const checks: Array<[string, boolean, string]> = [];
  checks.push(['Node.js', Number(process.versions.node.split('.')[0]) >= 20, process.versions.node]);
  checks.push(['Configuration', Boolean(path), path ?? 'agentforge.config.ts not found']);
  if (config.entry) {
    const entryPath = isAbsolute(config.entry) ? config.entry : resolve(process.cwd(), config.entry);
    try { await access(entryPath, constants.R_OK); checks.push(['Entrypoint', true, `${config.entry} (${entryPath})`]); }
    catch { checks.push(['Entrypoint', false, `missing: ${config.entry} (${entryPath})`]); }
  } else checks.push(['Entrypoint', false, 'set entry in agentforge.config.ts']);
  for (const provider of config.providers ?? []) {
    const name = typeof provider === 'string' ? provider : provider.name;
    const env = name === 'openai' ? 'OPENAI_API_KEY' : name === 'anthropic' ? 'ANTHROPIC_API_KEY' : name === 'google' || name === 'gemini' ? 'GOOGLE_API_KEY' : undefined;
    if (env) checks.push([`Provider ${name}`, Boolean(process.env[env]), `${env} ${process.env[env] ? 'set' : 'missing'}`]);
  }
  if (flagBoolean(flags, 'json')) { printJson({ path, checks: checks.map(([name, ok, detail]) => ({ name, ok, detail })) }); return checks.every(([, ok]) => ok) ? 0 : 1; }
  heading('AgentForge doctor');
  for (const [name, ok, detail] of checks) (ok ? success : warn)(`${ok ? '✓' : '!' } ${name}: ${detail}`);
  return checks.every(([, ok]) => ok) ? 0 : 1;
}

export async function connectCommand(provider: string | undefined, flags: Record<string, string | boolean>): Promise<number> {
  const name = provider ?? flagString(flags, 'provider');
  if (!name) throw new Error('Missing provider. Usage: agentforge connect <provider> (openai, anthropic, google, or custom).');
  const envName = name === 'openai' ? 'OPENAI_API_KEY' : name === 'anthropic' ? 'ANTHROPIC_API_KEY' : name === 'google' || name === 'gemini' ? 'GOOGLE_API_KEY' : undefined;
  process.env.AGENTFORGE_PROVIDER = name;
  process.env.AGENTFORGE_PROVIDER_MODULE = flagString(flags, 'module') ?? (envName ? '@agentforge/models' : name);
  if (!envName) {
    success(`Custom provider module selected for this session: ${process.env.AGENTFORGE_PROVIDER_MODULE}`);
    hint('The module may export default/model, createProvider(options), or createModel(options).');
    return 0;
  }
  if (process.env[envName]) { success(`${name} connected with ${envName} (redacted).`); return 0; }
  if (flagBoolean(flags, 'no-prompt')) { warn(`${envName} is not set. Export it before sending a model request.`); return 0; }
  const rl = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
  try {
    const value = (await rl.question(`${envName}: `)).trim();
    if (!value) throw new Error(`${envName} cannot be empty.`);
    process.env[envName] = value;
    success(`${name} connected for this session. The credential is not written to disk.`);
  } finally { rl.close(); }
  return 0;
}

export async function inspectCommand(runId: string | undefined, flags: Record<string, string | boolean>): Promise<number> {
  if (!runId) throw new Error('Missing run ID. Usage: agentforge inspect <run-id>.');
  const { config } = await loadConfig();
  let result: unknown;
  if (config.inspectRun) result = await config.inspectRun(runId);
  else if (config.storage?.getRun) result = await config.storage.getRun(runId);
  else {
    const path = join(process.cwd(), '.agentforge', 'runs', `${runId}.json`);
    try { result = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error(`Run ${runId} was not found and no storage adapter is configured.`); }
  }
  if (result === undefined || result === null) throw new Error(`Run ${runId} was not found.`);
  if (flagBoolean(flags, 'json')) printJson(result); else printJson(result);
  return 0;
}
