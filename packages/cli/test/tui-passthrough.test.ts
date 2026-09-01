import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildSlashRegistry, commandCatalog, type SlashHandlers } from '../src/ui/slash/registry.js';

function makeHandlers(): { handlers: SlashHandlers; calls: Array<{ name: string; args: string[] }> } {
  const calls: Array<{ name: string; args: string[] }> = [];
  const handlers: SlashHandlers = {
    openScreen: (screen, arg) => calls.push({ name: `screen:${screen}`, args: arg ? [arg] : [] }),
    // Capture what runSuspended is asked to run instead of executing CLI commands.
    runSuspended: async (fn) => { calls.push({ name: 'suspended', args: [fn.toString().slice(0, 120)] }); },
    pushSystem: (text) => calls.push({ name: 'system', args: [text] }),
    clearConversation: () => calls.push({ name: 'clear', args: [] }),
    exitRequested: () => calls.push({ name: 'exit', args: [] }),
    mode: () => 'project',
    setSessionModel: () => {},
    refreshStatus: () => {},
  };
  return { handlers, calls };
}

async function voidify(promise: unknown): Promise<void> { await promise; }

test('T: /permissions routes postures inline and rules to the CLI layer', async () => {
  const { handlers, calls } = makeHandlers();
  const registry = buildSlashRegistry(handlers);
  const find = (name: string) => registry.find((entry) => entry.name === name)!;

  await voidify(find('permissions')!.action(['trusted']));
  assert.ok(calls.some((call) => call.name === 'system' && call.args[0]!.includes('permission posture: trusted')));

  await voidify(find('permissions')!.action(['deny', 'run_command']));
  // Rule management executes the CLI implementation (via runSuspended);
  // it must NOT leave the posture system message from the inline path.
  assert.ok(!calls.some((call) => call.name === 'system' && call.args[0] === 'permission posture: deny'));

  await voidify(find('permissions')!.action([]));
  assert.ok(calls.some((call) => call.name === 'system' && call.args[0]!.includes('permission posture:')));
});

test('T: /skills routes review actions to the CLI layer, bare /skills opens the screen', async () => {
  const { handlers, calls } = makeHandlers();
  const registry = buildSlashRegistry(handlers);
  const find = (name: string) => registry.find((entry) => entry.name === name)!;

  await voidify(find('skills')!.action([]));
  assert.ok(calls.some((call) => call.name === 'screen:skills'));

  await voidify(find('skills')!.action(['pending']));
  assert.ok(calls.some((call) => call.name === 'suspended'));
  assert.ok(calls.some((call) => call.name === 'system' && /review/.test(call.args[0]!)));
});

test('T: /mcp /findings /benchmarks /gateway /daemon /sessions-admin passthroughs exist', async () => {
  const { handlers, calls } = makeHandlers();
  const registry = buildSlashRegistry(handlers);
  const find = (name: string) => registry.find((entry) => entry.name === name)!;

  await voidify(find('mcp')!.action(['list']));
  await voidify(find('findings')!.action([]));
  await voidify(find('benchmarks')!.action(['list']));
  await voidify(find('sessions-admin')!.action(['export', 'abc']));
  const suspended = calls.filter((call) => call.name === 'suspended');
  assert.equal(suspended.length, 4);

  // Long-running services are routed, not executed inline.
  const gateway = find('gateway')!;
  assert.match(gateway.usage!, /serve/);
  const daemon = find('daemon')!;
  assert.match(daemon.usage!, /status/);
});

test('T: /providers add routes to the CLI; bare /providers opens the manager', async () => {
  const { handlers, calls } = makeHandlers();
  const registry = buildSlashRegistry(handlers);
  const find = (name: string) => registry.find((entry) => entry.name === name)!;

  await voidify(find('providers')!.action([]));
  assert.ok(calls.some((call) => call.name === 'screen:models'));

  await voidify(find('providers')!.action(['add', 'my-gw', '--base-url', 'https://x/v1', '--model', 'glm-5.3']));
  assert.ok(calls.some((call) => call.name === 'suspended'));

  await voidify(find('providers')!.action(['test', 'my-gw']));
  assert.ok(calls.some((call) => call.name === 'system' && /test done/.test(call.args[0]!)));
});

test('T: /profile save persists without leaving the TUI', async () => {
  const { handlers, calls } = makeHandlers();
  const registry = buildSlashRegistry(handlers);
  await voidify(registry.find((entry) => entry.name === 'profile')!.action(['save', 'fast', '--provider', 'openai', '--model', 'gpt-5.6-luna']));
  assert.ok(calls.some((call) => call.name === 'system' && /'fast' saved/.test(call.args[0]!)));
  // Clean up the global profile store side effect.
  const { removeProfile } = await import('../src/profiles/profiles.js');
  await removeProfile('fast');
});

test('T: catalog includes every passthrough so /help stays complete', () => {
  const names = commandCatalog().map((entry) => entry.name);
  for (const expected of ['mcp', 'findings', 'benchmarks', 'gateway', 'daemon', 'sessions-admin', 'skills-admin']) {
    assert.ok(names.includes(expected), `catalog contains /${expected}`);
  }
});
