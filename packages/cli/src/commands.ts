import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { error, formatError, heading, hint, info, printJson, success, warn } from './output.js';
import { scaffold } from './project.js';
import { readExtensions } from './extensions/store.js';
import { listSkills, skillBodies } from './skills/skills.js';
import { buildTurnRunner, resolveRunnable } from './ui/turn.js';
import { loadProjectPlugins, PLUGIN_CONTRACT_VERSION } from './plugins/plugins.js';
import { buildModelReport, createSessionFromModule, drainStream, formatTurnFooter, isCancelLike } from './session.js';
import { addProviderEntry, readProviderEntries, removeProviderEntry, type ProviderEntry } from './providers-store.js';
import { addPermissionRule, readPermissionRules, removePermissionRule } from './permissions-store.js';
import type { AgentForgeConfig, ChatSession, NamedEntry, ParsedCli, RunnableModule } from './types.js';

export const VERSION = '1.0.2';

export const HELP = `AgentForge ${VERSION}

Usage:
  agentforge [command] [options]

Commands:
  init <name|.>      Scaffold a local AgentForge project
  dev                Start the configured development process
  run <entry>        Execute an agent or workflow entrypoint once (headless)
  chat [entry]       Interactive agent session (default when a project is configured; --plain to skip the TTY UI)
  models list        List model providers, credentials, and defaults
  models test <p>    Send a one-shot prompt to a provider/endpoint and report latency
  providers [sub]    List endpoints, or manage custom/proxy endpoints:
                       add <name> --protocol <p> --base-url <url> --model <id> --api-key-env <VAR>
                       remove <name>
                     Protocols: openai | anthropic | google | gemini | openai-compatible
  test [patterns]    Run deterministic project tests
  inspect <run-id>   Inspect a persisted run (or a stored session with --session)
  tools              List configured tools
  workflows [sub]    List configured workflows, or validate one:
                       validate <file.json>
  plugins [sub]      List plugins, or manage registrations:
                       add <path> | remove <path>
  sessions [sub]     List stored conversations, or:
                       resume <id> | rename <id> <title> | export <id> [--format md|json] [--out <path>]
                       prune --older-than-days <n> | --keep <n> [--dry-run] | delete <id>
  permissions [sub]  List per-tool permission rules, or manage them:
                       allow <tool> | deny <tool> | remove <tool>
                      Rules live in .agentforge/permissions.json; deny blocks
                      a tool in every mode, allow skips its approval prompt.
  mcp [sub]          List MCP servers, or manage them:
                       add <name> [--cwd <dir>] -- <command> [args...]
                       remove <name> | tools [server]
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

const CHAT_HELP = 'Commands: /help /exit /clear /status /memory /providers /tools /workflows /models /model <name> /mode [read-only|ask|workspace-write|trusted] /connect <provider>';

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
    provider: process.env.AGENTFORGE_PROVIDER ?? config.provider,
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
    case 'memory': {
      const { loadMemory, renderSnapshot } = await import('./memory/store.js');
      const cwd = process.cwd();
      for (const target of ['memory', 'user'] as const) {
        const snapshot = await loadMemory(target, cwd);
        info(renderSnapshot(target, snapshot.entries));
        info('');
      }
      hint('Entries persist across sessions. The agent edits them with the memory tool.');
      return 'handled';
    }
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
      const { SESSION_MODES, currentSessionMode, enterSessionMode, isSessionMode, SESSION_MODE_DEFINITIONS } = await import('./modes/session-modes.js');
      const requested = command.args[0];
      if (!requested) {
        info(`Session mode: ${currentSessionMode()} (options: ${SESSION_MODES.join(', ')})`);
        return 'handled';
      }
      if (!isSessionMode(requested)) {
        warn(`Unknown session mode '${requested}'. Options: ${SESSION_MODES.join(', ')}.`);
        return 'handled';
      }
      const result = enterSessionMode(requested);
      info(`Session mode set to '${result.mode}' (posture: ${result.postureApplied}) — ${SESSION_MODE_DEFINITIONS[result.mode].description}`);
      return 'handled';
    }
    case 'permissions': {
      const { PERMISSION_MODES, currentPermissionMode, setPermissionMode } = await import('./permissions-state.js');
      const requested = command.args[0];
      if (!requested) {
        info(`Permission posture: ${currentPermissionMode()} (options: ${PERMISSION_MODES.join(', ')})`);
        return 'handled';
      }
      if (!PERMISSION_MODES.includes(requested as never)) {
        warn(`Unknown posture '${requested}'. Options: ${PERMISSION_MODES.join(', ')}.`);
        return 'handled';
      }
      setPermissionMode(requested as typeof PERMISSION_MODES[number]);
      info(`Permission posture set to '${requested}' for this session.`);
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

/**
 * One-shot provider connectivity check: resolve the provider (builtin or
 * managed endpoint), send a minimal prompt, and report latency/usage — or a
 * precise failure (missing credential variable, HTTP status, retryability).
 */
export interface ModelProbeReport {
  provider: string;
  model?: string;
  ok: boolean;
  durationMs: number;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  finishReason?: string;
  preview: string;
}

/** Pure probe used by `agentforge models test` (kept testable without stdout capture). */
export async function modelProbe(name: string, flags: Record<string, string | boolean>): Promise<ModelProbeReport> {
  const { createModel, createConfiguredModel, ModelHttpError } = await import('@agentforge-oss/models');
  const { readProviderEntries } = await import('./providers-store.js');
  const managed = (await readProviderEntries()).find((entry) => entry.name === name);
  let model: { generate(request: { messages: Array<{ role: string; content: string }> }): Promise<{ content?: string; finishReason?: string; usage?: { totalTokens?: number }; model?: string }> };
  if (managed) {
    if (managed.apiKeyEnv && !process.env[managed.apiKeyEnv]) {
      throw new Error(`Managed endpoint '${name}' needs its credential: export ${managed.apiKeyEnv} first.`);
    }
    model = createConfiguredModel({ name: managed.name, protocol: managed.protocol, model: flagString(flags, 'model') ?? managed.model, baseUrl: managed.baseUrl, apiKeyEnv: managed.apiKeyEnv }) as never;
  } else if (['openai', 'anthropic', 'google', 'gemini'].includes(name)) {
    try {
      model = createModel({ provider: name as 'openai' | 'anthropic' | 'google', model: flagString(flags, 'model') }) as never;
    } catch (error) {
      throw new Error(`${(error as Error).message} (or add a managed endpoint: agentforge providers add <name> ...)`);
    }
  } else {
    throw new Error(`Unknown provider '${name}'. Known builtins: openai, anthropic, google, gemini. Managed endpoints: agentforge providers list.`);
  }
  const prompt = flagString(flags, 'prompt') ?? 'Reply with the single word: ok';
  const started = Date.now();
  try {
    const response = await model.generate({ messages: [{ role: 'user', content: prompt }] });
    const durationMs = Date.now() - started;
    return {
      provider: name,
      model: response.model ?? flagString(flags, 'model') ?? managed?.model,
      ok: true,
      durationMs,
      usage: response.usage,
      finishReason: response.finishReason ?? 'stop',
      preview: (response.content ?? '').slice(0, 80).replace(/\s+/g, ' '),
    };
  } catch (error) {
    if (error instanceof ModelHttpError) {
      const retryHint = error.retryable ? ` (retryable${error.retryAfterMs !== undefined ? `, retry-after ${error.retryAfterMs}ms` : ''})` : ' (not retryable)';
      throw new Error(`${name} request failed with HTTP ${error.status}${retryHint}: ${error.message.replace(/^Model provider request failed \(\d+\): /, '')}`);
    }
    throw error;
  }
}

export async function modelsTestCommand(args: string[], flags: Record<string, string | boolean>): Promise<number> {
  const name = args[0];
  if (!name) throw new Error('Usage: agentforge models test <provider> [--model <id>] [--prompt <text>].');
  const report = await modelProbe(name, flags);
  if (flagBoolean(flags, 'json')) {
    printJson(report);
    return 0;
  }
  success(`${report.provider} responded in ${report.durationMs}ms${report.usage?.totalTokens ? ` · ${report.usage.totalTokens} tokens` : ''}`);
  hint(`  reply: ${report.preview || '(empty)'}`);
  return 0;
}

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

/**
 * Validate a workflow document file (.json) with precise structural errors.
 * Structural-only: handler availability is checked when a handlers registry
 * ships with the document environment, which the CLI does not have.
 */
export async function workflowsValidateCommand(path: string | undefined, flags: Record<string, string | boolean>): Promise<number> {
  if (!path) throw new Error('Usage: agentforge workflows validate <file.json>.');
  const { readFileSync } = await import('node:fs');
  const { validateWorkflowDocument } = await import('@agentforge-oss/workflows');
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  let text: string;
  try { text = readFileSync(absolute, 'utf8'); } catch { throw new Error(`Workflow document not found: ${absolute}`); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (error) { throw new Error(`Workflow document is not valid JSON: ${(error as Error).message}`); }
  const result = validateWorkflowDocument(parsed);
  if (flagBoolean(flags, 'json')) { printJson({ path: absolute, ...result }); return result.ok ? 0 : 1; }
  if (result.ok) {
    success(`✓ Workflow document ${path} is valid${result.warnings.length ? ` with ${result.warnings.length} warning(s)` : ''}.`);
    for (const warning of result.warnings) warn(`! ${warning}`);
    return 0;
  }
  for (const failure of result.errors) error(`✗ ${failure}`);
  for (const warning of result.warnings) warn(`! ${warning}`);
  return 1;
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
  const extensions = await readExtensions();
  const { plugins, failures } = await loadProjectPlugins(extensions);
  for (const plugin of plugins) {
    checks.push([`Plugin ${plugin.name}`, true, `${plugin.path}${plugin.tools.length ? ` · tools: ${plugin.tools.join(', ')}` : ''}`]);
  }
  for (const failure of failures) checks.push(['Plugin', false, `${failure.path}: ${failure.reason}`]);
  const mcpServers = extensions.mcp?.servers ?? [];
  if (!mcpServers.length) checks.push(['MCP servers', true, 'none configured']);
  for (const server of mcpServers) {
    // Security surface: show exactly what executable will be launched.
    checks.push([`MCP server ${server.name}`, true, `command: ${JSON.stringify(server.command)}${server.cwd ? ` · cwd: ${server.cwd}` : ''}`]);
  }
  if (flagBoolean(flags, 'json')) { printJson({ path, checks: checks.map(([name, ok, detail]) => ({ name, ok, detail })) }); return checks.every(([, ok]) => ok) ? 0 : 1; }
  heading('AgentForge doctor');
  for (const [name, ok, detail] of checks) (ok ? success : warn)(`${ok ? '✓' : '!' } ${name}: ${detail}`);
  return checks.every(([, ok]) => ok) ? 0 : 1;
}

export async function pluginsCommand(flags: Record<string, string | boolean>): Promise<number> {
  const extensions = await readExtensions();
  const { plugins, failures } = await loadProjectPlugins(extensions);
  const disabled = new Set((extensions.plugins ?? []).filter((entry) => typeof entry !== 'string' && entry.disabled).map((entry) => (entry as { path: string }).path));
  if (flagBoolean(flags, 'json')) { printJson({ plugins, failures, disabled: [...disabled] }); return failures.length ? 1 : 0; }
  heading('AgentForge plugins');
  const entries = extensions.plugins ?? [];
  if (!entries.length) { hint('No plugins configured. Add one with `agentforge plugins add <path>` or .agentforge/extensions.json.'); return 0; }
  for (const plugin of plugins) {
    const isDisabled = disabled.has(plugin.path);
    (isDisabled ? warn : success)(`${isDisabled ? '⏸' : '✓'} ${plugin.name}${plugin.description ? ` — ${plugin.description}` : ''}${isDisabled ? ' (disabled)' : ''}`);
    info(`    contributes: ${plugin.contributions.length ? plugin.contributions.join(', ') : '(nothing)'}`);
    if (plugin.tools.length) info(`    tools: ${plugin.tools.join(', ')}`);
    if (plugin.slashCommands.length) info(`    slash: /${plugin.slashCommands.join(' /')}`);
    if (plugin.compat !== undefined && plugin.compat > PLUGIN_CONTRACT_VERSION) warn(`    targets contract v${plugin.compat} (CLI implements v${PLUGIN_CONTRACT_VERSION})`);
  }
  for (const failure of failures) warn(`! ${failure.path}: ${failure.reason}`);
  hint('Lifecycle: agentforge plugins enable|disable <name>');
  return failures.length ? 1 : 0;
}

/** Enable or disable a registered plugin by name (lifecycle persisted in extensions.json). */
export async function pluginsLifecycleCommand(action: 'enable' | 'disable', name: string | undefined): Promise<number> {
  if (!name) throw new Error(`Usage: agentforge plugins ${action} <name>.`);
  const extensions = await readExtensions();
  const { plugins } = await loadProjectPlugins(extensions);
  const target = plugins.find((plugin) => plugin.name === name);
  if (!target) throw new Error(`Plugin '${name}' is not loaded. Registered plugins: ${plugins.map((plugin) => plugin.name).join(', ') || '(none)'}.`);
  const entries = (extensions.plugins ?? []).map((entry) => {
    if (typeof entry === 'string') return entry;
    if (resolve(entry.path) !== resolve(target.path)) return entry;
    return { ...entry, disabled: action === 'disable' };
  });
  const { writeExtensions } = await import('./extensions/store.js');
  await writeExtensions({ ...extensions, plugins: entries });
  (action === 'disable' ? success : info)(`Plugin ${name} ${action}d. Restart the session for it to take effect.`);
  return 0;
}

/** Register a plugin module path in .agentforge/extensions.json. */
export async function pluginsAddCommand(path: string | undefined): Promise<number> {
  if (!path) throw new Error('Missing path. Usage: agentforge plugins add <path-to-module>.');
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  await access(absolute, constants.R_OK);
  const extensions = await readExtensions();
  const existing = extensions.plugins ?? [];
  const duplicate = existing.some((entry) => (typeof entry === 'string' ? entry : entry.path) === absolute);
  let registeredName = absolute;
  if (!duplicate) {
    const { loadProjectPlugins: verify } = await import('./plugins/plugins.js');
    const probe = await verify({ ...extensions, plugins: [...existing, absolute] });
    if (probe.failures.length) throw new Error(`Plugin failed to load: ${probe.failures[0]?.reason}`);
    registeredName = probe.plugins.at(-1)?.name ?? absolute;
    const { writeExtensions } = await import('./extensions/store.js');
    await writeExtensions({ ...extensions, plugins: [...existing, absolute] });
  }
  success(`Plugin registered: ${registeredName}`);
  hint(String(absolute));
  return 0;
}

export async function pluginsRemoveCommand(path: string | undefined): Promise<number> {
  if (!path) throw new Error('Missing path. Usage: agentforge plugins remove <path>.');
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  const extensions = await readExtensions();
  const existing = extensions.plugins ?? [];
  const next = existing.filter((entry) => (typeof entry === 'string' ? entry : entry.path) !== absolute);
  if (next.length === existing.length) { warn(`Not registered: ${absolute}`); return 1; }
  const { writeExtensions } = await import('./extensions/store.js');
  await writeExtensions({ ...extensions, plugins: next });
  success(`Plugin removed: ${absolute}`);
  return 0;
}

/** MCP server management: list/add/remove against .agentforge/extensions.json. */
export async function mcpCommand(args: string[], flags: Record<string, string | boolean>): Promise<number> {
  const [sub, name] = args;
  const extensions = await readExtensions();
  const servers = extensions.mcp?.servers ?? [];
  if (!sub || sub === 'list' || sub === 'ls') {
    if (flagBoolean(flags, 'json')) { printJson({ servers }); return 0; }
    heading('AgentForge MCP servers');
    if (!servers.length) { hint('No MCP servers configured. Add one with `agentforge mcp add <name> -- <command> [args...]`.'); return 0; }
    for (const server of servers) info(`  ${server.name}  ${JSON.stringify(server.command)}${server.cwd ? `  cwd=${server.cwd}` : ''}`);
    return 0;
  }
  const { writeExtensions } = await import('./extensions/store.js');
  if (sub === 'add') {
    if (!name) throw new Error('Missing name. Usage: agentforge mcp add <name> [--cwd <dir>] -- <command> [args...].');
    if (servers.some((server) => server.name === name)) throw new Error(`MCP server already configured: ${name}`);
    const separator = args.indexOf('--');
    // Tokens after the separator are the launch command; strip stray separators
    // so inputs like `-- --` can never register an empty/garbage command.
    const command = (separator === -1 ? args.slice(2) : args.slice(separator + 1)).filter((token) => token && token !== '--');
    if (!command.length || command[0]?.startsWith('-')) {
      throw new Error('Missing command. Usage: agentforge mcp add <name> [--cwd <dir>] -- <command> [args...].');
    }
    const cwdFlag = flagString(flags, 'cwd');
    const next = [...servers, { name, command, ...(cwdFlag ? { cwd: resolve(process.cwd(), cwdFlag) } : {}) }];
    await writeExtensions({ ...extensions, mcp: { servers: next } });
    success(`MCP server registered: ${name} → ${JSON.stringify(command)}${cwdFlag ? ` (cwd: ${resolve(process.cwd(), cwdFlag)})` : ''}`);
    hint('The exact executable above will be launched when a session starts. Verify with `agentforge doctor`.');
    return 0;
  }
  if (sub === 'remove' || sub === 'rm') {
    if (!name) throw new Error('Missing name. Usage: agentforge mcp remove <name>.');
    const next = servers.filter((server) => server.name !== name);
    if (next.length === servers.length) { warn(`MCP server not configured: ${name}`); return 1; }
    await writeExtensions({ ...extensions, mcp: { servers: next } });
    success(`MCP server removed: ${name}`);
    return 0;
  }
  if (sub === 'tools') {
    const target = name ? servers.filter((server) => server.name === name) : servers;
    if (name && !target.length) throw new Error(`MCP server not configured: ${name}`);
    const { projectMcpTools } = await import('./mcp/bridge.js');
    const scopedExtensions: typeof extensions = { ...extensions, mcp: { servers: target } };
    const started = Date.now();
    const { tools, failures } = await projectMcpTools(scopedExtensions);
    if (flagBoolean(flags, 'json')) { printJson({ tools: tools.map((tool) => (tool as { name: string }).name), failures }); return failures.length ? 1 : 0; }
    heading('MCP tools');
    for (const tool of tools) info(`  ${(tool as { name: string }).name}`);
    for (const failure of failures) warn(`! ${failure.server}: ${failure.reason}`);
    hint(`${tools.length} tool(s) from ${target.length - failures.length} server(s) in ${Date.now() - started}ms`);
    return failures.length && !tools.length ? 1 : 0;
  }
  throw new Error(`Unknown mcp subcommand: ${sub}. Usage: agentforge mcp [list|add|remove|tools].`);
}

export async function sessionsCommand(args: string[], flags: Record<string, string | boolean>): Promise<number> {
  const [sub, id, ...rest] = args;
  const { listSessions, loadSession, deleteSession, renameSession, pruneSessions, locateSession } = await import('./sessions/store.js');
  if (!sub || sub === 'list' || sub === 'ls') {
    const all = await listSessions();
    if (flagBoolean(flags, 'json')) { printJson({ sessions: all }); return 0; }
    heading('AgentForge sessions');
    if (!all.length) { hint('No stored sessions yet. They are created automatically as you chat.'); return 0; }
    for (const entry of all.slice(0, 12)) info(`  ${entry.id}  ${String(entry.messages).padStart(3)} msgs  ${entry.title}`);
    hint(`resume with: agentforge sessions resume <id> · rename <id> <title> · export <id> · prune --older-than-days <n> | --keep <n>`);
    return 0;
  }
  if (sub === 'delete' || sub === 'rm') {
    if (!id) throw new Error('Missing id. Usage: agentforge sessions delete <id>.');
    const removed = await deleteSession(id);
    (removed ? success : warn)(removed ? `Deleted session ${id}` : `Unknown session: ${id}`);
    return removed ? 0 : 1;
  }
  if (sub === 'rename') {
    if (!id || !rest.length) throw new Error('Usage: agentforge sessions rename <id> <new title>.');
    if (await renameSession(id, rest.join(' '))) { success(`Renamed session ${id}.`); return 0; }
    warn(`Unknown session: ${id}`);
    return 1;
  }
  if (sub === 'export') {
    if (!id) throw new Error('Usage: agentforge sessions export <id> [--out <path>].');
    const found = await locateSession(id);
    if (!found) throw new Error(`Unknown session: ${id}`);
    const format = flagString(flags, 'format') ?? 'md';
    const target = flagString(flags, 'out') ?? join(process.cwd(), `${id}.${format === 'json' ? 'json' : 'md'}`);
    const body = format === 'json'
      ? JSON.stringify(found.session, null, 2)
      : [
          `# ${found.session.title}`,
          '',
          `- id: ${found.session.id}`,
          `- created: ${found.session.createdAt}`,
          `- updated: ${found.session.updatedAt}`,
          `- provider/model: ${found.session.provider ?? '?'}/${found.session.model ?? '?'}`,
          '',
          ...found.session.messages.map((message) => `## ${message.role}\n\n${message.text}\n`),
        ].join('\n');
    await writeFile(target, body, 'utf8');
    success(`Exported session ${id} to ${target}`);
    return 0;
  }
  if (sub === 'prune') {
    const olderThanDays = flagString(flags, 'older-than-days');
    const keep = flagString(flags, 'keep');
    if (!olderThanDays && !keep) throw new Error('Usage: agentforge sessions prune --older-than-days <n> and/or --keep <n> [--dry-run].');
    const removed = await pruneSessions({
      olderThanDays: olderThanDays !== undefined ? Number(olderThanDays) : undefined,
      keep: keep !== undefined ? Number(keep) : undefined,
      dryRun: flagBoolean(flags, 'dry-run'),
    });
    if (flagBoolean(flags, 'json')) { printJson({ removed }); return 0; }
    if (!removed.length) { success('Nothing to prune.'); return 0; }
    for (const removedId of removed) (flagBoolean(flags, 'dry-run') ? info : success)(`  ${flagBoolean(flags, 'dry-run') ? 'would remove' : 'removed'} ${removedId}`);
    return 0;
  }
  if (sub === 'resume') {
    const stored = await loadSession(id ?? '');
    if (!stored) throw new Error(`Unknown session: ${id ?? '(none)'}`);
    const { launchInteractiveShell } = await import('./interactive.js');
    const launched = await launchInteractiveShell({
      initialMessages: stored.messages.map((message) => ({ role: message.role, text: message.text })),
    });
    return launched ? 0 : 1;
  }
  if (sub === 'fork') {
    const { forkSession } = await import('./sessions/log.js');
    const result = await forkSession(id ?? '', {
      title: flagString(flags, 'title'),
      upTo: flagString(flags, 'up-to') !== undefined ? Number(flagString(flags, 'up-to')) : undefined,
      global: flagBoolean(flags, 'global') || undefined,
    });
    if (!result) throw new Error(`Unknown session: ${id ?? '(none)'}`);
    if (flagBoolean(flags, 'json')) { printJson({ forkedFrom: result.from, id: result.session.id, copied: result.copied, title: result.session.title }); return 0; }
    success(`Forked ${result.from} → ${result.session.id} (${result.copied} msgs, '${result.session.title}').`);
    hint(`Resume it with: agentforge sessions resume ${result.session.id}`);
    return 0;
  }
  if (sub === 'transcript') {
    const { loadFullTranscript } = await import('./sessions/log.js');
    const target = id ?? args[1];
    if (!target) throw new Error('Usage: agentforge sessions transcript <id>.');
    const full = await loadFullTranscript(target);
    if (flagBoolean(flags, 'json')) { printJson({ id: target, messages: full }); return 0; }
    if (!full.length) throw new Error(`No durable transcript for ${target}.`);
    info(`Full transcript ${target} — ${full.length} message(s):`);
    for (const message of full) stdout.write(`  ${message.role} › ${message.text}\n`);
    return 0;
  }
  throw new Error(`Unknown sessions subcommand: ${sub}. Usage: agentforge sessions [list|resume|rename|export|prune|fork|transcript|delete].`);
}

export async function permissionsCommand(args: string[], flags: Record<string, string | boolean>): Promise<number> {
  const [sub, tool] = args;
  if (!sub || sub === 'list' || sub === 'ls') {
    const rules = await readPermissionRules();
    if (flagBoolean(flags, 'json')) { printJson({ rules }); return 0; }
    heading('Permission rules (.agentforge/permissions.json)');
    if (!rules.length) {
      hint('No per-tool rules yet.');
      hint('Add one with: agentforge permissions allow <tool> | deny <tool>');
      return 0;
    }
    for (const rule of rules) info(`  ${rule.action.padEnd(6)} ${rule.tool}`);
    hint('deny blocks a tool in every mode; allow skips its approval prompt.');
    hint('Qualified forms: tool:prefix=<line> (run_command), external_directory:<path>, glob patterns.');
    hint('Workspace path checks always apply unless an external_directory rule grants a path.');
    return 0;
  }
  if (sub === 'allow' || sub === 'deny') {
    if (!tool) throw new Error(`Usage: agentforge permissions ${sub} <tool>.`);
    const prefix = flags.prefix;
    const target = typeof prefix === 'string' && prefix.length
      ? `${tool}:prefix=${prefix}`
      : tool;
    const result = await addPermissionRule(target, sub, { force: flagBoolean(flags, 'force') });
    success(`${result.replaced ? 'Replaced' : 'Added'} rule: ${sub} ${target} in .agentforge/permissions.json`);
    return 0;
  }
  if (sub === 'remove' || sub === 'rm') {
    if (!tool) throw new Error('Usage: agentforge permissions remove <tool>.');
    if (await removePermissionRule(tool)) { success(`Removed rule for '${tool}' from .agentforge/permissions.json.`); return 0; }
    warn(`No rule for '${tool}' was found in .agentforge/permissions.json.`);
    return 1;
  }
  throw new Error(`Unknown permissions subcommand: ${sub}. Usage: agentforge permissions [list|allow|deny|remove].`);
}

/** Skill review flow: pending staged writes, diff preview, approve/reject. */
export async function skillsCommand(args: string[], flags: Record<string, string | boolean>): Promise<number> {
  const [sub, id] = args;
  const { listStagedWrites, approveStagedWrite, rejectStagedWrite } = await import('./skills/skills.js');
  const { listSkills } = await import('./skills/skills.js');
  if (!sub || sub === 'list' || sub === 'ls') {
    const skills = await listSkills();
    const staged = await listStagedWrites();
    if (flagBoolean(flags, 'json')) { printJson({ skills: skills.map((skill) => ({ name: skill.name, description: skill.description, folder: skill.dir !== undefined })), staged }); return 0; }
    heading('AgentForge skills (.agentforge/skills)');
    if (!skills.length) hint('No skills yet. Drop SKILL.md folders into .agentforge/skills/.');
    for (const skill of skills) info(`  ${skill.name}${skill.description ? ` — ${skill.description}` : ''}${skill.dir ? ' [folder]' : ''}`);
    if (staged.length) {
      heading('Pending skill writes');
      for (const entry of staged) info(`  ${entry.id}  ${entry.action} ${entry.skill}`);
      hint(`Review with: agentforge skills diff <id> · approve <id> · reject <id>`);
    }
    return 0;
  }
  if (sub === 'pending') {
    const staged = await listStagedWrites();
    if (flagBoolean(flags, 'json')) { printJson({ staged }); return 0; }
    heading('Pending skill writes');
    if (!staged.length) { success('Nothing pending.'); return 0; }
    for (const entry of staged) info(`  ${entry.id}  ${entry.action} ${entry.skill}${entry.content ? `  (${entry.content.length} chars)` : ''}`);
    return 0;
  }
  if (sub === 'diff') {
    if (!id) throw new Error('Usage: agentforge skills diff <id>.');
    const staged = (await listStagedWrites()).find((entry) => entry.id === id);
    if (!staged) throw new Error(`Unknown staged write: ${id}`);
    printJson(staged);
    return 0;
  }
  if (sub === 'approve') {
    if (!id) throw new Error('Usage: agentforge skills approve <id> (or "all").');
    if (id === 'all') {
      const staged = await listStagedWrites();
      for (const entry of staged) success(await approveStagedWrite(entry.id));
      return 0;
    }
    success(await approveStagedWrite(id));
    return 0;
  }
  if (sub === 'reject') {
    if (!id) throw new Error('Usage: agentforge skills reject <id> (or "all").');
    if (id === 'all') {
      const staged = await listStagedWrites();
      for (const entry of staged) await rejectStagedWrite(entry.id);
      success(`Rejected ${staged.length} staged write(s).`);
      return 0;
    }
    const removed = await rejectStagedWrite(id);
    (removed ? success : warn)(removed ? `Staged write ${id} rejected.` : `Staged write ${id} was already gone.`);
    return 0;
  }
  throw new Error(`Unknown skills subcommand: ${sub}. Usage: agentforge skills [list|pending|diff|approve|reject].`);
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
  if (!runId) throw new Error('Missing run ID. Usage: agentforge inspect <run-id> [--session].');
  const { config } = await loadConfig();

  // Session inspection: --session, or a bare id shaped like run_/s- session ids.
  const looksLikeSession = flagBoolean(flags, 'session') || /^s-[0-9a-z]+-[0-9a-f]{6}$/.test(runId);
  if (looksLikeSession) {
    const { loadSession } = await import('./sessions/store.js');
    const stored = await loadSession(runId);
    if (!stored) {
      if (flagBoolean(flags, 'session')) throw new Error(`Session ${runId} was not found.`);
    } else {
      const result = {
        session: { id: stored.id, title: stored.title, createdAt: stored.createdAt, updatedAt: stored.updatedAt, provider: stored.provider, model: stored.model, version: stored.version ?? 1, summary: stored.summary },
        messages: stored.messages,
      };
      if (flagBoolean(flags, 'json')) printJson(result);
      else {
        heading(`Session ${stored.id} — ${stored.title}`);
        hint(`${stored.messages.length} message(s) · provider ${stored.provider ?? '?'} · model ${stored.model ?? '?'} · updated ${stored.updatedAt}`);
        info('');
        for (const message of stored.messages.slice(-30)) {
          info(`  ${message.role.padEnd(9)} ${message.text.length > 160 ? `${message.text.slice(0, 160)}…` : message.text.replace(/\n/g, ' ')}`);
        }
        if (stored.summary) hint('\n[compacted] earlier turns are summarized in the stored session.');
      }
      return 0;
    }
  }

  let result: unknown;
  if (config.inspectRun) result = await config.inspectRun(runId);
  else if (config.storage?.getRun) result = await config.storage.getRun(runId);
  else {
    const path = join(process.cwd(), '.agentforge', 'runs', `${runId}.json`);
    try { result = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error(`Run ${runId} was not found and no storage adapter is configured (sessions can be inspected with --session).`); }
  }
  if (result === undefined || result === null) throw new Error(`Run ${runId} was not found.`);
  if (flagBoolean(flags, 'json')) printJson(result); else printJson(result);
  return 0;
}

/** Profiles (Phase P): named provider/model/posture bundles. */
export async function profileCommand(args: string[], flags: Record<string, string | boolean>): Promise<number> {
  const { listProfiles, getProfile, saveProfile, removeProfile, activeProfileName, setActiveProfile, resolveProfileToEnvValues } = await import('./profiles/profiles.js');
  const [sub, name] = args;
  if (!sub || sub === 'list' || sub === 'ls') {
    const profiles = await listProfiles();
    const active = await activeProfileName();
    if (flagBoolean(flags, 'json')) { printJson({ active, profiles }); return 0; }
    heading('Profiles (~/.agentforge/profiles.json, .agentforge/profiles.json)');
    if (!profiles.length) { hint('No profiles yet. Create one with: agentforge profile save <name> --provider <p> --model <m> [--mode read-only|ask|workspace-write|trusted]'); return 0; }
    for (const profile of profiles) {
      info(`  ${profile.name}${profile.name === active ? ' [active]' : ''}  ${[profile.provider, profile.model].filter(Boolean).join('/') || '(session defaults)'}${profile.permissionMode ? ` · ${profile.permissionMode}` : ''}`);
    }
    hint('Activate with: agentforge profile use <name>');
    return 0;
  }
  if (sub === 'save') {
    if (!name) throw new Error('Usage: agentforge profile save <name> [--provider <p>] [--model <m>] [--mode <posture>] [--scope project|global].');
    const mode = flagString(flags, 'mode');
    const saved = await saveProfile({
      name,
      provider: flagString(flags, 'provider'),
      model: flagString(flags, 'model'),
      permissionMode: mode ? (mode as 'read-only' | 'ask' | 'workspace-write' | 'trusted') : undefined,
    }, { scope: flagString(flags, 'scope') as 'project' | 'global' | undefined });
    success(`${saved.replaced ? 'Replaced' : 'Saved'} profile '${name}' in ${saved.path}`);
    return 0;
  }
  if (sub === 'remove' || sub === 'rm') {
    if (!name) throw new Error('Usage: agentforge profile remove <name>.');
    if (await removeProfile(name)) { success(`Removed profile '${name}'.`); return 0; }
    warn(`No profile '${name}' found.`);
    return 1;
  }
  if (sub === 'use') {
    if (!name) throw new Error('Usage: agentforge profile use <name>.');
    const profile = await getProfile(name);
    if (!profile) throw new Error(`Unknown profile '${name}'. List with: agentforge profile list`);
    const values = resolveProfileToEnvValues(profile);
    if (values.provider) process.env.AGENTFORGE_PROVIDER = values.provider;
    if (values.model) process.env.AGENTFORGE_MODEL = values.model;
    if (values.permissionMode) {
      const { setPermissionMode } = await import('./permissions.js');
      setPermissionMode(values.permissionMode);
    }
    await setActiveProfile(name, flagString(flags, 'scope') === 'project' ? 'project' : 'global');
    success(`Profile '${name}' active: ${[values.provider, values.model].filter(Boolean).join('/') || '(session defaults)'}${values.permissionMode ? ` · ${values.permissionMode}` : ''}`);
    return 0;
  }
  if (sub === 'current') {
    const active = await activeProfileName();
    if (active) info(`Active profile: ${active}`);
    else info('No profile active (session defaults).');
    return 0;
  }
  throw new Error('Usage: agentforge profile [list|save|use|current|remove].');
}

/** Observability (Phase Q): inspect the local-first run event log. */
export async function runsCommand(args: string[], flags: Record<string, string | boolean>): Promise<number> {
  const { readRunIndex, readRunEvents, summarizeRunEvents, pruneObservability } = await import('./observability/sink.js');
  const [sub, runId] = args;
  if (!sub || sub === 'list' || sub === 'ls') {
    const index = await readRunIndex(undefined, flagBoolean(flags, 'all') ? Infinity : 20);
    if (flagBoolean(flags, 'json')) { printJson({ runs: index }); return 0; }
    heading('Runs (.agentforge/observability/)');
    if (!index.length) { hint('No runs observed yet. Events land here automatically during coding sessions.'); return 0; }
    for (const entry of index) {
      info(`  ${entry.runId}  ${entry.status.padEnd(10)}  ${entry.startedAt}  ${Object.values(entry.counts).reduce((sum, count) => sum + count, 0)} events`);
    }
    return 0;
  }
  if (sub === 'show' || sub === 'events') {
    if (!runId) throw new Error('Usage: agentforge runs show <runId> [--json].');
    const events = await readRunEvents(runId);
    if (!events) throw new Error(`No event log for run '${runId}'.`);
    if (flagBoolean(flags, 'json')) { printJson({ runId, events }); return 0; }
    info(summarizeRunEvents(events));
    const verbose = flagBoolean(flags, 'verbose');
    if (verbose) {
      for (const event of events) info(`  ${event.timestamp}  ${event.type}  ${JSON.stringify(event.data).slice(0, 160)}`);
    }
    return 0;
  }
  if (sub === 'prune') {
    const days = Number(flagString(flags, 'older-than-days') ?? '14');
    if (!Number.isFinite(days) || days <= 0) throw new Error('Usage: agentforge runs prune --older-than-days <n>.');
    const removed = await pruneObservability(days);
    if (flagBoolean(flags, 'json')) { printJson({ removed }); return 0; }
    success(removed.length ? `Pruned ${removed.length} run log(s) older than ${days} day(s).` : 'Nothing to prune.');
    return 0;
  }
  throw new Error('Usage: agentforge runs [list|show <runId>|prune --older-than-days <n>].');
}

/** Security findings (Phase R): read the observe-only findings log. */
export async function findingsCommand(args: string[], flags: Record<string, string | boolean>): Promise<number> {
  const { readFindings, summarizeFindings, clearFindings } = await import('./findings/scanner.js');
  const [sub] = args;
  if (!sub || sub === 'list' || sub === 'ls') {
    const limit = Number(flagString(flags, 'limit') ?? '50');
    const findings = await readFindings(undefined, Number.isFinite(limit) ? limit : 50);
    if (flagBoolean(flags, 'json')) { printJson({ findings }); return 0; }
    heading('Security findings (.agentforge/observability/findings.ndjson)');
    info(`  ${summarizeFindings(findings)}`);
    for (const finding of findings.slice(-20)) {
      info(`  [${finding.severity}] ${finding.kind} — ${finding.tool}: ${finding.summary}`);
      if (finding.detail && !flagBoolean(flags, 'quiet')) hint(`    ${finding.detail.slice(0, 140).replace(/\n/g, ' ')}`);
    }
    hint('Findings are observations, not gates. Review them; they never blocked execution.');
    return 0;
  }
  if (sub === 'clear') {
    const days = Number(flagString(flags, 'older-than-days') ?? '0');
    const cleared = await clearFindings(Number.isFinite(days) ? days : 0);
    success(cleared ? `Cleared ${cleared} finding(s).` : 'No findings matched.');
    return 0;
  }
  throw new Error('Usage: agentforge findings [list|clear --older-than-days <n>].');
}

/** Gateway (Phase J): serve an OpenAI-compatible endpoint over a local agent. */
export async function gatewayCommand(args: string[], flags: Record<string, string | boolean>): Promise<number> {
  const [{ createGatewayServer, listenGateway }, { createModel, DEFAULT_MODEL_IDS }] = await Promise.all([
    import('./gateway/server.js'),
    import('@agentforge-oss/models'),
  ]);
  const [sub] = args;
  if (sub && sub !== 'serve') throw new Error('Usage: agentforge gateway serve [--port <n>] [--host <addr>] [--model <name>].');
  const provider = (flagString(flags, 'provider') ?? process.env.AGENTFORGE_PROVIDER ?? 'anthropic') as never;
  const modelName = flagString(flags, 'model') ?? process.env.AGENTFORGE_MODEL;
  let modelInstance: unknown;
  try {
    modelInstance = createModel({ provider, model: modelName ?? DEFAULT_MODEL_IDS.anthropic });
  } catch (error) {
    throw new Error(`Gateway cannot start: ${(error as Error).message}`);
  }
  const server = createGatewayServer({
    modelInstance,
    model: modelName,
    buildInstructions: () => 'You are AgentForge, a terminal coding agent. Be concise and factual.',
  });
  const port = Number(flagString(flags, 'port') ?? '8787');
  const host = flagString(flags, 'host') ?? '127.0.0.1';
  const bound = await listenGateway(server, port, host);
  success(`AgentForge gateway listening on http://${host}:${bound}/v1/chat/completions`);
  hint('POST /v1/chat/completions (OpenAI-compatible) · GET /healthz');
  hint('Ctrl-C to stop.');
  await new Promise<void>((resolveRun) => process.once('SIGINT', () => { server.close(() => resolveRun()); resolveRun(); }));
  return 0;
}

/** Daemon (Phase K): foreground heartbeat loop + supervised install. */
export async function daemonCommand(args: string[], flags: Record<string, string | boolean>): Promise<number> {
  const [sub] = args;
  const { daemonPaths, runDaemon, readHeartbeat, heartbeatIsFresh, launchdPlabel, launchdPlist, systemdUnit } = await import('./daemon/daemon.js');
  const paths = daemonPaths();
  if (sub === 'run') {
    const { buildAgentRunner } = await import('./coding-session.js');
    const interval = Number(flagString(flags, 'interval-ms') ?? '30000');
    const runner = buildAgentRunner({});
    info(`AgentForge daemon starting (interval ${interval}ms) — heartbeat: ${paths.heartbeat}`);
    info(`Drop job files into ${paths.jobs} (JSON: {"id":"...","type":"prompt","text":"..."})`);
    const result = await runDaemon({ runner, intervalMs: Number.isFinite(interval) ? interval : 30_000 });
    success(`daemon stopped after ${result.beats} beats (${result.jobsProcessed} jobs ok, ${result.jobsFailed} failed)`);
    return 0;
  }
  if (sub === 'status') {
    const heartbeat = await readHeartbeat();
    if (!heartbeat) { info('daemon: not running (no heartbeat).'); return 0; }
    const fresh = heartbeatIsFresh(heartbeat);
    info(`daemon pid ${heartbeat.pid}: ${fresh ? 'alive' : 'STALE'} — beats ${heartbeat.beats}, jobs ${heartbeat.jobsProcessed} ok / ${heartbeat.jobsFailed} failed, last beat ${heartbeat.lastBeat}`);
    return fresh ? 0 : 1;
  }
  if (sub === 'stop') {
    await (await import('node:fs/promises')).mkdir(paths.root, { recursive: true });
    await (await import('node:fs/promises')).writeFile(paths.stop, `${new Date().toISOString()}\n`, 'utf8');
    success(`Stop file written — the daemon will exit on its next beat: ${paths.stop}`);
    return 0;
  }
  if (sub === 'install') {
    const { homedir, platform } = await import('node:os');
    const projectName = process.cwd().split('/').pop() ?? 'project';
    if (platform() === 'darwin') {
      const label = launchdPlabel(projectName);
      const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
      const { writeFile: write, mkdir: mkdirs } = await import('node:fs/promises');
      await mkdirs(join(plistPath, '..'), { recursive: true });
      await write(plistPath, launchdPlist(label, process.execPath, join(process.cwd(), 'node_modules', '.bin', 'agentforge'), process.cwd()), 'utf8');
      success(`launchd plist written: ${plistPath}`);
      hint(`Load it with: launchctl load ${plistPath}  (supervised; restarts on failure)`);
      return 0;
    }
    const unitDir = join(homedir(), '.config', 'systemd', 'user');
    const unitPath = join(unitDir, `agentforge-${projectName.replace(/[^a-zA-Z0-9.-]/g, '-')}.service`);
    const { writeFile: write, mkdir: mkdirs } = await import('node:fs/promises');
    await mkdirs(unitDir, { recursive: true });
    await write(unitPath, systemdUnit(process.cwd(), join(process.cwd(), 'node_modules', '.bin', 'agentforge')), 'utf8');
    success(`systemd user unit written: ${unitPath}`);
    hint(`Enable with: systemctl --user enable --now ${unitPath.split('/').pop()}  (supervised; restarts on failure)`);
    return 0;
  }
  throw new Error('Usage: agentforge daemon [run|status|stop|install].');
}

/** Benchmarks (Phase S): deterministic-only scoring — no model judges. */
export async function benchmarksCommand(args: string[], flags: Record<string, string | boolean>): Promise<number> {
  const { BUILTIN_BENCHMARKS, getBenchmark, runBenchmark, recordBenchmarkResult, readBenchmarkResults, scoreResults } = await import('./benchmarks/benchmarks.js');
  const [sub, id] = args;
  if (!sub || sub === 'list' || sub === 'ls') {
    if (flagBoolean(flags, 'json')) { printJson({ benchmarks: BUILTIN_BENCHMARKS.map((entry) => ({ id: entry.id, description: entry.description })) }); return 0; }
    heading('Benchmarks (deterministic checkers only — no model judges)');
    for (const entry of BUILTIN_BENCHMARKS) info(`  ${entry.id.padEnd(16)} ${entry.description}`);
    hint('Run with: agentforge benchmarks run <id>  (or --all)');
    return 0;
  }
  if (sub === 'run') {
    const targets = flagBoolean(flags, 'all') ? [...BUILTIN_BENCHMARKS] : id ? [getBenchmark(id) ?? (() => { throw new Error(`Unknown benchmark '${id}'. List with: agentforge benchmarks list`); })()] : (() => { throw new Error('Usage: agentforge benchmarks run <id> [--all].'); })();
    const provider = (flagString(flags, 'provider') ?? process.env.AGENTFORGE_PROVIDER ?? 'auto');
    const label = flagString(flags, 'label') ?? `${provider}${process.env.AGENTFORGE_MODEL ? `/${process.env.AGENTFORGE_MODEL}` : ''}`;
    const { buildAgentRunner } = await import('./coding-session.js');
    const runner = buildAgentRunner({ observability: false });
    let passed = 0;
    for (const benchmark of targets) {
      const result = await runBenchmark(benchmark, { runner, label });
      await recordBenchmarkResult(result);
      (result.passed ? success : warn)(`  ${result.passed ? 'PASS' : 'FAIL'}  ${result.id} (${result.durationMs}ms) — ${result.detail}`);
      if (result.passed) passed += 1;
    }
    info(`Score: ${passed}/${targets.length} passed. Results appended to .agentforge/benchmarks/results.ndjson`);
    return passed === targets.length ? 0 : 1;
  }
  if (sub === 'results') {
    const results = await readBenchmarkResults();
    const score = scoreResults(results);
    if (flagBoolean(flags, 'json')) { printJson({ score, results }); return 0; }
    heading('Benchmark results (.agentforge/benchmarks/results.ndjson)');
    if (!results.length) { hint('No results yet.'); return 0; }
    for (const result of results.slice(-20)) info(`  ${result.ts}  ${result.passed ? 'PASS' : 'FAIL'}  ${result.id}  ${result.detail}`);
    info(`Latest score: ${score.passed}/${score.total}`);
    return 0;
  }
  throw new Error('Usage: agentforge benchmarks [list|run <id>|results].');
}

/** Channels (Phase L): webhook + Telegram adapters into the agent. */
export async function channelsCommand(args: string[], flags: Record<string, string | boolean>): Promise<number> {
  const [sub] = args;
  const { buildAgentRunner } = await import('./coding-session.js');
  const runnerTurn = buildAgentRunner({ observability: false });
  const runner = async (text: string, sender: string): Promise<string> => {
    let output = '';
    for await (const delta of runnerTurn(text, new AbortController().signal, {} as never)) output += delta.text ?? '';
    return output || `(empty reply for ${sender})`;
  };
  if (sub === 'webhook') {
    const { createWebhookServer, listenWebhook } = await import('./channels/channels.js');
    const server = createWebhookServer({ runner, secret: flagString(flags, 'secret') ?? process.env.AGENTFORGE_WEBHOOK_SECRET });
    const port = Number(flagString(flags, 'port') ?? '8788');
    const bound = await listenWebhook(server, port, flagString(flags, 'host') ?? '127.0.0.1');
    success(`Webhook channel listening on http://127.0.0.1:${bound}/hook${flagString(flags, 'secret') || process.env.AGENTFORGE_WEBHOOK_SECRET ? ' (secret required)' : ' (no secret — dev only)'}`);
    hint('POST /hook {"sender":"you","text":"hi"} · Ctrl-C to stop.');
    await new Promise<void>((resolveRun) => process.once('SIGINT', () => { server.close(() => resolveRun()); resolveRun(); }));
    return 0;
  }
  if (sub === 'telegram') {
    const { runTelegramLoop } = await import('./channels/channels.js');
    const token = flagString(flags, 'token') ?? process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('Telegram needs a bot token: --token or TELEGRAM_BOT_TOKEN.');
    const allowed = flagString(flags, 'allow-chat')?.split(',').map(Number).filter(Number.isFinite);
    info('Telegram channel: long-polling. Ctrl-C to stop.');
    await runTelegramLoop({ token, runner, allowedChatIds: allowed ? new Set(allowed) : undefined });
    return 0;
  }
  throw new Error('Usage: agentforge channels [webhook [--port <n>] [--secret <s>] | telegram [--token <t>] [--allow-chat <ids>]].');
}
