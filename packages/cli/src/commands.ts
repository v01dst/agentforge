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
import { readExtensions } from './extensions/store.js';
import { listSkills, skillBodies } from './skills/skills.js';
import { buildTurnRunner, resolveRunnable } from './ui/turn.js';
import { buildModelReport, createSessionFromModule, drainStream, formatTurnFooter, isCancelLike } from './session.js';
import { addProviderEntry, readProviderEntries, removeProviderEntry, type ProviderEntry } from './providers-store.js';
import type { AgentForgeConfig, ChatSession, NamedEntry, ParsedCli, RunnableModule } from './types.js';

export const VERSION = '0.3.1';

export const HELP = `AgentForge ${VERSION}

Usage:
  agentforge [command] [options]

Commands:
  init <name|.>      Scaffold a local AgentForge project
  dev                Start the configured development process
  run <entry>        Execute an agent or workflow entrypoint once (headless)
  chat [entry]       Interactive agent session (default when a project is configured; --plain to skip the TTY UI)
  models list        List model providers, credentials, and defaults
  providers [sub]    List endpoints, or manage custom/proxy endpoints:
                       add <name> --protocol <p> --base-url <url> --model <id> --api-key-env <VAR>
                       remove <name>
                     Protocols: openai | anthropic | google | gemini | openai-compatible
  test [patterns]    Run deterministic project tests
  inspect <run-id>   Inspect a persisted run
  tools              List configured tools
  workflows          List configured workflows
  doctor             Check the local AgentForge project
  connect <provider> Configure a provider credential or endpoint

Chat slash commands:
  /help /status /providers /tools /workflows /models
  /model <name> /connect <provider> /clear /exit

Global options:
  --help, -h         Show this help
  --version, -v      Show the CLI version
  --json             Emit machine-readable output where supported
  --cwd <path>       Run against a different project directory

Environment:
  AGENTFORGE_PROVIDER       Provider used by sessions (mock | openai | anthropic | google | managed endpoint name)
  AGENTFORGE_MODEL          Model name override for interactive sessions
  AGENTFORGE_BASE_URL       Endpoint override for OpenAI-compatible providers
`;

const CHAT_HELP = 'Commands: /help /exit /clear /status /providers /tools /workflows /models /model <name> /mode [read-only|ask|workspace-write|trusted] /connect <provider>';

function flagBoolean(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === 'true';
}

function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

function resolveModelName(model: AgentForgeConfig['model']): string | undefined {
  if (typeof model === 'string') return model;
  return model?.model;
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

/** Run a persistent terminal session. Renders an Ink UI on TTYs; plain readline otherwise. */
export async function chatCommand(entry: string | undefined, flags: Record<string, string | boolean>): Promise<number> {
  const { path: configPath, config } = await loadConfig();
  const selected = entry ?? config.entry;
  if (!selected) throw new Error('Missing entrypoint. Usage: agentforge chat <entry> or set entry in agentforge.config.ts.');
  const module: RunnableModule = await importEntry(selected, { configPath });

  if (process.stdout.isTTY && !flagBoolean(flags, 'plain')) {
    return await runInteractiveChat(module, config);
  }
  return await runPlainChat(module);
}

async function runInteractiveChat(module: RunnableModule, config: AgentForgeConfig): Promise<number> {
  const [{ render }, React, { ChatApp }] = await Promise.all([
    import('ink'),
    import('react'),
    import('./ui/ChatApp.js'),
  ]);
  const baseRunner = buildTurnRunner(module);
  const availableSkills = await listSkills();
  const extensions = await readExtensions();
  const runner = (input: string, signal: AbortSignal, context: { skills: readonly string[] }) =>
    baseRunner(input, signal, { skills: skillBodies(availableSkills, context.skills) });
  const instance = render(React.createElement(ChatApp, {
    runner,
    provider: process.env.AGENTFORGE_PROVIDER ?? config.provider ?? 'mock',
    model: process.env.AGENTFORGE_MODEL ?? resolveModelName(config.model),
    skills: availableSkills,
    extensions: {
      plugins: (extensions.plugins ?? []).map((plugin) => typeof plugin === 'string' ? plugin : plugin.path),
      mcpServers: (extensions.mcp?.servers ?? []).map((server) => server.name),
    },
  }));
  await instance.waitUntilExit();
  return 0;
}

function parseChatSlash(raw: string): { name: string; args: string[] } | undefined {
  if (!raw.startsWith('/')) return undefined;
  const parts = raw.slice(1).split(/\s+/).filter(Boolean);
  const name = parts[0]?.toLowerCase();
  if (!name) return undefined;
  return { name, args: parts.slice(1) };
}

async function handleChatSlash(line: string, session: ChatSession): Promise<'handled' | 'exit'> {
  const command = parseChatSlash(line);
  if (!command) return 'handled';
  switch (command.name) {
    case 'exit':
    case 'quit':
      return 'exit';
    case 'help':
      info(CHAT_HELP);
      return 'handled';
    case 'clear':
      await session.reset?.();
      info('Conversation cleared.');
      return 'handled';
    case 'providers':
      await listCommand('providers', {});
      return 'handled';
    case 'tools':
      await listCommand('tools', {});
      return 'handled';
    case 'workflows':
      await listCommand('workflows', {});
      return 'handled';
    case 'models':
      await modelsCommand({});
      return 'handled';
    case 'status':
    case 'doctor':
      await doctorCommand({});
      return 'handled';
    case 'connect':
      await connectCommand(command.args[0], { 'no-prompt': true });
      return 'handled';
    case 'model': {
      const model = command.args[0];
      if (!model) info(`Current model: ${process.env.AGENTFORGE_MODEL ?? 'configured by project'}`);
      else { process.env.AGENTFORGE_MODEL = model; info(`Model set for this session: ${model}`); }
      return 'handled';
    }
    case 'mode': {
      const { PERMISSION_MODES, currentPermissionMode, setPermissionMode } = await import('./permissions-state.js');
      const requested = command.args[0];
      if (!requested) {
        info(`Permission mode: ${currentPermissionMode()} (options: ${PERMISSION_MODES.join(', ')})`);
        return 'handled';
      }
      if (!PERMISSION_MODES.includes(requested as never)) {
        warn(`Unknown mode '${requested}'. Options: ${PERMISSION_MODES.join(', ')}.`);
        return 'handled';
      }
      setPermissionMode(requested as typeof PERMISSION_MODES[number]);
      info(`Permission mode set to '${requested}' for this session.`);
      return 'handled';
    }
    default:
      warn(`Unknown command: ${line}. Type /help.`);
      return 'handled';
  }
}

async function sendAndRender(session: ChatSession, input: string, signal?: AbortSignal): Promise<void> {
  const started = Date.now();
  try {
    const turn = await session.send(input, signal ? { signal } : undefined);
    let footer: string | undefined;
    if (turn.stream) {
      stdout.write('agent › ');
      const drained = await drainStream(turn.stream, (delta) => stdout.write(delta), signal);
      stdout.write('\n');
      if (!drained.text && !drained.cancelled) info('(empty response)');
      if (drained.cancelled) warn('turn cancelled');
      footer = formatTurnFooter({
        runId: drained.runId ?? turn.runId,
        usage: drained.usage ?? turn.usage,
        durationMs: turn.durationMs ?? Date.now() - started,
        meta: drained.meta ?? turn.meta,
      });
    } else {
      info(`agent › ${turn.text || '(empty response)'}`);
      footer = formatTurnFooter({
        runId: turn.runId,
        usage: turn.usage,
        durationMs: turn.durationMs ?? Date.now() - started,
        meta: turn.meta,
      });
    }
    if (footer) hint(footer);
  } catch (caught) {
    if (isCancelLike(caught) || signal?.aborted) warn('turn cancelled');
    else error(`Error: ${formatError(caught)}`);
  }
}

async function readPipedLines(): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function runPlainChat(module: RunnableModule): Promise<number> {
  const session = await createSessionFromModule(module);
  if (!stdin.isTTY) {
    for (const line of await readPipedLines()) {
      if (parseChatSlash(line)) { if ((await handleChatSlash(line, session)) === 'exit') break; continue; }
      info(`you   › ${line}`);
      await sendAndRender(session, line);
    }
    await session.close?.();
    return 0;
  }

  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  let exitRequested = false;
  let busy = false;
  let currentAbort: AbortController | undefined;
  let lastInterruptAt = 0;
  const onInterrupt = () => {
    if (busy && currentAbort) { currentAbort.abort(); return; }
    const now = Date.now();
    if (now - lastInterruptAt < 2000) { exitRequested = true; rl.close(); return; }
    lastInterruptAt = now;
    info('\nPress Ctrl-C again to exit.');
  };
  process.once('SIGINT', onInterrupt);
  rl.on('SIGINT', onInterrupt);
  info('AgentForge chat (plain mode). Type /help for commands, Ctrl-C twice to quit.');
  try {
    while (!exitRequested) {
      let line: string;
      try { line = (await rl.question('\nyou   › ')).trim(); }
      catch { break; }
      if (exitRequested) break;
      if (!line) continue;
      while (line.endsWith('\\')) line = `${line.slice(0, -1)}\n${(await rl.question('…     › ')).replace(/\\$/, '')}`;
      if (parseChatSlash(line)) { if ((await handleChatSlash(line, session)) === 'exit') break; continue; }
      busy = true;
      currentAbort = new AbortController();
      try { await sendAndRender(session, line, currentAbort.signal); }
      finally { busy = false; currentAbort = undefined; }
    }
  } finally {
    rl.close();
    process.removeListener('SIGINT', onInterrupt);
    await session.close?.();
  }
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

export async function modelsCommand(flags: Record<string, string | boolean>): Promise<number> {
  const { config } = await loadConfig({ required: false });
  const rows = buildModelReport(config.providers ?? []);
  if (flagBoolean(flags, 'json')) { printJson({ models: rows }); return 0; }
  heading('Models');
  for (const row of rows) {
    const credentials = row.envVars.length ? row.envVars.join(' | ') : row.apiKeyEnv ? row.apiKeyEnv : 'no credential';
    const state = row.ready === null ? 'config-defined' : row.ready ? 'ready' : 'credential missing';
    info(`  ${row.provider.padEnd(24)} ${(row.protocol ?? '').padEnd(18)} ${(credentials).padEnd(30)} ${(row.defaultModel ?? '').padEnd(26)} ${state}`);
    hint(`    ${row.description}${row.baseUrl ? ` · ${row.baseUrl}` : ''}${row.source === 'config' && !row.protocol ? ' · from agentforge.config.ts' : ''}`);
  }
  const selectedProvider = process.env.AGENTFORGE_PROVIDER ?? config.provider;
  const selectedModel = typeof config.model === 'string' ? config.model : config.model?.model ?? process.env.AGENTFORGE_MODEL;
  if (selectedProvider || selectedModel) hint(`Session default: ${selectedProvider ?? '(project default)'}${selectedModel ? `/${selectedModel}` : ''}`);
  hint('Change with AGENTFORGE_PROVIDER / AGENTFORGE_MODEL, agentforge connect <provider>, or /model <name> inside chat.');
  hint('Add custom endpoints: agentforge providers add <name> --protocol openai-compatible --base-url <url> --model <id> --api-key-env <VAR>');
  return 0;
}

const PROVIDER_PROTOCOLS = ['openai', 'anthropic', 'google', 'gemini', 'openai-compatible'] as const;

export async function providersCommand(args: string[], flags: Record<string, string | boolean>): Promise<number> {
  const [sub, name] = args;
  if (!sub || sub === 'list' || sub === 'ls') {
    const managed = await readProviderEntries();
    if (managed.length) {
      heading('Managed endpoints (.agentforge/providers.json)');
      for (const entry of managed) {
        info(`  ${entry.name.padEnd(24)} ${entry.protocol.padEnd(18)} ${entry.model ?? ''}`);
        hint(`    ${entry.baseUrl ?? '(no base URL)'} · credential: ${entry.apiKeyEnv ? `${entry.apiKeyEnv} ${process.env[entry.apiKeyEnv] ? '(set)' : '(missing)'}` : 'none required'}`);
      }
      info('');
    }
    return await listCommand('providers', flags);
  }
  if (sub === 'add') {
    if (!name) throw new Error('Usage: agentforge providers add <name> --protocol <openai|anthropic|google|gemini|openai-compatible> --base-url <url> --model <id> --api-key-env <VAR>');
    const protocolInput = flagString(flags, 'protocol') ?? 'openai-compatible';
    if (!PROVIDER_PROTOCOLS.includes(protocolInput as typeof PROVIDER_PROTOCOLS[number])) {
      throw new Error(`Unsupported --protocol '${protocolInput}'. Choose one of ${PROVIDER_PROTOCOLS.join(', ')}.`);
    }
    const added = await addProviderEntry(name, {
      protocol: protocolInput as ProviderEntry['protocol'],
      baseUrl: flagString(flags, 'base-url'),
      model: flagString(flags, 'model'),
      apiKeyEnv: flagString(flags, 'api-key-env'),
      force: flagBoolean(flags, 'force'),
    });
    success(`${added.replaced ? 'Replaced' : 'Added'} endpoint '${added.entry.name}' (${added.entry.protocol}) in .agentforge/providers.json`);
    if (added.entry.apiKeyEnv) hint(`Export ${added.entry.apiKeyEnv} before use; secrets are never stored in this file.`);
    else hint('No credential variable configured; local endpoints may not need one.');
    hint(`Use it with AGENTFORGE_PROVIDER=${added.entry.name} or /model ${added.entry.name} inside a chat session.`);
    return 0;
  }
  if (sub === 'remove' || sub === 'rm') {
    if (!name) throw new Error('Usage: agentforge providers remove <name>.');
    if (await removeProviderEntry(name)) { success(`Removed endpoint '${name}' from .agentforge/providers.json.`); return 0; }
    warn(`Endpoint '${name}' was not found in .agentforge/providers.json.`);
    return 1;
  }
  throw new Error(`Unknown providers subcommand: ${sub}. Usage: agentforge providers [list|add|remove].`);
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
  if (localRoot) {
    hint(`Next: cd ${name === '.' ? '.' : name} && pnpm install && pnpm exec agentforge chat`);
    hint(`Local-link mode: packages are linked from ${resolve(localRoot)} via file: dependencies.`);
  } else {
    hint(`Next: cd ${name === '.' ? '.' : name} && npm install && npx agentforge chat`);
    warn('@agentforge packages are not published to a registry yet. Prefer local-link mode:');
    hint(`  agentforge init ${name} --local-root <path-to-agentforge-repo>   (or set AGENTFORGE_REPO_ROOT)`);
  }
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
    const args = ['--filter', '@agentforge-oss/playground', 'dev'];
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
  process.env.AGENTFORGE_PROVIDER_MODULE = flagString(flags, 'module') ?? (envName ? '@agentforge-oss/models' : name);
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
