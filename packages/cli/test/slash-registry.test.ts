import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildSlashRegistry, dispatchSlash, parseSlashInput, slashCommandNames, type SlashHandlers } from '../src/ui/slash/registry.js';

const EXPECTED_COMMANDS = [
  'help', 'connect', 'providers', 'models', 'model', 'tools', 'skills', 'agents',
  'workflows', 'runs', 'inspect', 'test', 'doctor', 'config', 'settings', 'clear',
  'status', 'init', 'new', 'project', 'chat', 'exit',
];

function stubHandlers(): SlashHandlers & { screens: Array<{ screen: string; arg?: string }>; system: string[] } {
  const handlers = {
    screens: [] as Array<{ screen: string; arg?: string }>,
    system: [] as string[],
    cleared: 0,
    exits: 0,
    openScreen: (screen: Parameters<SlashHandlers['openScreen']>[0], arg?: string) => { handlers.screens.push({ screen, arg }); },
    runSuspended: async (fn: () => Promise<number>) => { await fn(); },
    pushSystem: (text: string) => { handlers.system.push(text); },
    clearConversation: () => { handlers.cleared += 1; },
    exitRequested: () => { handlers.exits += 1; },
  };
  return handlers as typeof handlers & { cleared: number; exits: number };
}

test('registry contains every expected command', () => {
  const registry = buildSlashRegistry(stubHandlers());
  const names = slashCommandNames(registry);
  for (const expected of EXPECTED_COMMANDS) {
    assert.ok(names.includes(expected), `missing command /${expected}`);
  }
});

test('parseSlashInput extracts name and args, rejects non-commands', () => {
  assert.equal(parseSlashInput('hello'), null);
  assert.equal(parseSlashInput('/'), null);
  assert.deepEqual(parseSlashInput('/model gpt-4o-mini'), { name: 'model', args: ['gpt-4o-mini'] });
  assert.deepEqual(parseSlashInput('  /exit  '), { name: 'exit', args: [] });
});

test('/clear calls clearConversation and /exit calls exitRequested', () => {
  const handlers = stubHandlers();
  const registry = buildSlashRegistry(handlers);
  const byName = new Map(registry.map((entry) => [entry.name, entry]));

  void byName.get('clear')?.action([]);
  assert.equal((handlers as unknown as { cleared: number }).cleared, 1);

  void byName.get('exit')?.action([]);
  assert.equal((handlers as unknown as { exits: number }).exits, 1);
});

test('screen commands route through openScreen with expected targets', () => {
  const handlers = stubHandlers();
  const registry = buildSlashRegistry(handlers);
  const byName = new Map(registry.map((entry) => [entry.name, entry]));

  void byName.get('help')?.action([]);
  void byName.get('providers')?.action([]);
  void byName.get('models')?.action([]);
  void byName.get('tools')?.action([]);
  void byName.get('agents')?.action([]);
  void byName.get('workflows')?.action([]);
  void byName.get('runs')?.action([]);
  void byName.get('doctor')?.action([]);
  void byName.get('config')?.action([]);
  void byName.get('settings')?.action([]);
  void byName.get('init')?.action([]);
  void byName.get('new')?.action([]);
  void byName.get('project')?.action([]);

  const screens = handlers.screens.map((call) => call.screen);
  for (const expected of ['help', 'models', 'models', 'tools', 'run', 'workflows', 'runs', 'doctor-result', 'settings', 'settings', 'new-project', 'new-project', 'new-project']) {
    assert.ok(screens.includes(expected), `expected a navigation to ${expected}`);
  }
});

test('/inspect requires an id and forwards it', () => {
  const handlers = stubHandlers();
  const registry = buildSlashRegistry(handlers);
  const inspect = registry.find((entry) => entry.name === 'inspect');
  assert.ok(inspect);

  void inspect.action([]);
  assert.ok(handlers.system.some((text) => text.includes('Usage')));
  assert.equal(handlers.screens.length, 0);

  void inspect.action(['run-42']);
  assert.deepEqual(handlers.screens[0], { screen: 'inspect', arg: 'run-42' });
});

test('unknown command reports via pushSystem', () => {
  const handlers = stubHandlers();
  const registry = buildSlashRegistry(handlers);
  const handled = dispatchSlash(registry, '/definitely-not-a-command', handlers.pushSystem);
  assert.equal(handled, true);
  assert.match(handlers.system.join('\n'), /Unknown command: \/definitely-not-a-command — try \/help/);
});

test('dispatchSlash returns false for plain chat input and routes known commands', () => {
  const handlers = stubHandlers();
  const registry = buildSlashRegistry(handlers);
  assert.equal(dispatchSlash(registry, 'just chatting', handlers.pushSystem), false);
  assert.equal(dispatchSlash(registry, '/clear', handlers.pushSystem), true);
  assert.equal((handlers as unknown as { cleared: number }).cleared, 1);
});

test('/model without arg shows current model; with arg sets AGENTFORGE_MODEL', () => {
  const handlers = stubHandlers();
  const registry = buildSlashRegistry(handlers);
  const model = registry.find((entry) => entry.name === 'model');
  assert.ok(model);

  const previous = process.env.AGENTFORGE_MODEL;
  try {
    delete process.env.AGENTFORGE_MODEL;
    void model.action([]);
    assert.ok(handlers.system.at(-1)?.includes('(unset)'));

    void model.action(['test-model-x']);
    assert.equal(process.env.AGENTFORGE_MODEL, 'test-model-x');
    assert.ok(handlers.system.at(-1)?.includes('test-model-x'));
  } finally {
    if (previous === undefined) delete process.env.AGENTFORGE_MODEL;
    else process.env.AGENTFORGE_MODEL = previous;
  }
});
