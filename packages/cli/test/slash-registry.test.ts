import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildSlashRegistry,
  dispatchSlash,
  findCommand,
  parseSlashInput,
  slashCommandNames,
  type CommandContext,
  type RegisteredCommand,
  type SlashScreen,
} from '../src/ui/slash/registry.js';

const EXPECTED_COMMANDS = [
  'help', 'connect', 'providers', 'models', 'model', 'tools', 'skills', 'agents',
  'workflows', 'runs', 'inspect', 'test', 'doctor', 'config', 'settings', 'clear',
  'status', 'exit', 'version', 'reload', 'cd', 'new', 'chat',
];

interface TestCtx extends CommandContext {
  screens: Array<{ screen: SlashScreen; arg?: string }>;
  system: string[];
  cleared: number;
  exits: number;
  suspended: number;
  models: string[];
  refreshed: number;
}

function stubCtx(overrides: Partial<CommandContext> = {}): TestCtx {
  const ctx: TestCtx = {
    screens: [],
    system: [],
    cleared: 0,
    exits: 0,
    suspended: 0,
    models: [],
    refreshed: 0,
    mode: () => 'global',
    pushSystem: (text: string) => { ctx.system.push(text); },
    clearConversation: () => { ctx.cleared += 1; },
    exitRequested: () => { ctx.exits += 1; },
    openScreen: (screen: SlashScreen, arg?: string) => { ctx.screens.push({ screen, arg }); },
    runSuspended: async (fn: () => Promise<number>) => { ctx.suspended += 1; await fn(); },
    setSessionModel: (model: string) => { ctx.models.push(model); },
    refreshStatus: () => { ctx.refreshed += 1; },
    ...overrides,
  };
  return ctx;
}

function byName(registry: readonly RegisteredCommand[]): Map<string, RegisteredCommand> {
  return new Map(registry.map((entry) => [entry.name, entry]));
}

async function voidify(_value?: unknown): Promise<void> {
  // dispatchSlash returns synchronously while handlers run async; drain the
  // event loop so fire-and-forget handlers complete before assertions.
  for (let i = 0; i < 20; i += 1) await new Promise<void>((resolveTick) => setTimeout(resolveTick, 10));
}

test('every registered command has a non-empty handler function', () => {
  const registry = buildSlashRegistry(stubCtx());
  assert.ok(registry.length > 0);
  for (const entry of registry) {
    assert.equal(typeof entry.run, 'function', `/${entry.name} has no run()`);
    assert.equal(typeof entry.action, 'function', `/${entry.name} has no action()`);
    assert.ok(entry.run.length >= 0);
    assert.ok(entry.name.length > 0 && entry.description.length > 0);
    for (const alias of entry.aliases ?? []) {
      assert.ok(alias.length > 0, `/ ${entry.name} has an empty alias`);
    }
  }
  const names = slashCommandNames(registry);
  for (const expected of EXPECTED_COMMANDS) {
    assert.ok(names.includes(expected), `missing command /${expected}`);
  }
});

test('aliases resolve: /quit routes to exit handler', async () => {
  const ctx = stubCtx();
  const registry = buildSlashRegistry(ctx);
  const quit = findCommand(registry, 'quit');
  assert.ok(quit, '/quit did not resolve via aliases');
  assert.equal(quit.name, 'exit');
  await dispatchSlash(registry, '/quit', ctx);
  assert.equal(ctx.exits, 1);
});

test('project-gated commands in global mode explain instead of throwing, with /new hint', async () => {
  const ctx = stubCtx(); // mode defaults to 'global'
  const registry = buildSlashRegistry(ctx);
  for (const name of ['agents', 'workflows']) {
    const command = findCommand(registry, name);
    assert.ok(command);
    await dispatchSlash(registry, `/${name}`, ctx);
    const joined = ctx.system.join('\n');
    assert.match(joined, /\/new/, `${name} should hint at /new`);
  }
  // runs/inspect explain that runs are per-project
  await dispatchSlash(registry, '/runs', ctx);
  assert.match(ctx.system.join('\n'), /no runs — runs are stored per project/);
});

test('unknown command reports via pushSystem and never throws', () => {
  const ctx = stubCtx();
  const registry = buildSlashRegistry(ctx);
  assert.equal(dispatchSlash(registry, '/definitely-not-a-command', ctx), true);
  assert.match(ctx.system.join('\n'), /Unknown command: \/definitely-not-a-command — try \/help/);
  assert.equal(dispatchSlash(registry, 'just chatting', ctx), false);
});

test('dispatcher converts handler errors into a system message', async () => {
  const ctx = stubCtx();
  const registry = buildSlashRegistry(ctx);
  const broken: RegisteredCommand[] = [
    ...registry,
    {
      name: 'explode',
      description: 'always throws',
      category: 'system',
      run: () => { throw new Error('boom'); },
      action: () => { throw new Error('boom'); },
    },
  ];
  assert.doesNotThrow(() => dispatchSlash(broken, '/explode', ctx));
  assert.match(ctx.system.join('\n'), /✗ \/explode failed: boom — try \/help/);
});

test('/version prints the VERSION from commands.js', async () => {
  const ctx = stubCtx();
  const registry = buildSlashRegistry(ctx);
  await dispatchSlash(registry, '/version', ctx);
  const { VERSION } = await import('../src/commands.js');
  assert.ok(ctx.system.at(-1)?.includes(VERSION), `expected VERSION (${VERSION}) in "${ctx.system.at(-1)}"`);
});

test('/cd without argument changes cwd to HOME (tmp HOME)', async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'af-home-'));
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  try {
    mkdirSync(join(fakeHome, '.agentforge'), { recursive: true });
    writeFileSync(join(fakeHome, 'marker.txt'), 'x');
    process.env.HOME = fakeHome;
    const ctx = stubCtx();
    const registry = buildSlashRegistry(ctx);
    await dispatchSlash(registry, '/cd', ctx);
    assert.equal(resolve(process.cwd()), resolve(fakeHome));
    assert.ok(ctx.system.some((text) => text.includes('cwd →')));
    assert.equal(ctx.refreshed, 1); // /cd refreshes once after the cwd change
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('/model with arg calls setSessionModel; unknown model is rejected politely', async () => {
  const previous = process.env.AGENTFORGE_MODEL;
  try {
    delete process.env.AGENTFORGE_MODEL;
    const ctx = stubCtx({ mode: () => 'project' });
    const registry = buildSlashRegistry(ctx);

    // Any model id is accepted — the model list comes live from the
    // provider endpoint, so no static list can gate it.
    await dispatchSlash(registry, '/model totally-not-a-model-xyz', ctx);
    assert.deepEqual(ctx.models, ['totally-not-a-model-xyz']);
    assert.equal(process.env.AGENTFORGE_MODEL, 'totally-not-a-model-xyz');

    // A second dispatch replaces it; both refresh the status line.
    await dispatchSlash(registry, '/model gpt-5.6-sol', ctx);
    assert.deepEqual(ctx.models.at(-1), 'gpt-5.6-sol');
    assert.equal(process.env.AGENTFORGE_MODEL, 'gpt-5.6-sol');
    assert.equal(ctx.refreshed, 2); // both accepted dispatches refresh; the no-arg view does not

    // No arg → shows current model without changing it.
    await dispatchSlash(registry, '/model', ctx);
    assert.equal(ctx.models.length, 2);
    assert.match(ctx.system.at(-1) ?? '', /gpt-5\.6-sol/);
  } finally {
    if (previous === undefined) delete process.env.AGENTFORGE_MODEL;
    else process.env.AGENTFORGE_MODEL = previous;
  }
});

test('parseSlashInput extracts name and args, rejects non-commands', () => {
  assert.equal(parseSlashInput('hello'), null);
  assert.equal(parseSlashInput('/'), null);
  assert.deepEqual(parseSlashInput('/model gpt-4o-mini'), { name: 'model', args: ['gpt-4o-mini'] });
  assert.deepEqual(parseSlashInput('  /exit  '), { name: 'exit', args: [] });
});

test('/clear calls clearConversation and screen commands still route', async () => {
  const ctx = stubCtx({ mode: () => 'project' });
  const registry = buildSlashRegistry(ctx);
  const commands = byName(registry);
  await voidify(commands.get('clear')!.run([], ctx));
  assert.equal(ctx.cleared, 1);
  for (const name of ['help', 'providers', 'models', 'tools', 'skills', 'doctor', 'config', 'settings', 'connect', 'new']) {
    await dispatchSlash(registry, `/${name}`, ctx);
  }
  const screens = ctx.screens.map((call) => call.screen);
  for (const expected of ['help', 'models', 'models', 'tools', 'skills', 'doctor', 'settings', 'settings', 'connect', 'new-project']) {
    assert.ok(screens.includes(expected as SlashScreen), `expected navigation to ${expected}, got ${screens.join(',')}`);
  }
});

test('backward-compat action() entry point still works with legacy handlers', async () => {
  const calls: string[] = [];
  const handlers = {
    openScreen: () => { calls.push('screen'); },
    runSuspended: async (fn: () => Promise<number>) => { await fn(); },
    pushSystem: (text: string) => { calls.push(text); },
    clearConversation: () => { calls.push('clear'); },
    exitRequested: () => { calls.push('exit'); },
  };
  const registry = buildSlashRegistry(handlers);
  const exit = findCommand(registry, 'exit');
  assert.ok(exit);
  await voidify(exit.action([]));
  assert.ok(calls.includes('exit'));
});
