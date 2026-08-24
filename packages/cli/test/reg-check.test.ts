import { buildSlashRegistry } from '../src/ui/slash/registry.js';
import { test } from 'node:test';
import assert from 'node:assert';

test('registry filters /mo', () => {
  const handlers = {
    openScreen: () => {},
    runSuspended: async () => {},
    pushSystem: () => {},
    clearConversation: () => {},
    exitRequested: () => {},
  };
  const registry = buildSlashRegistry(handlers);
  const matches = registry.filter((c) => c.name.startsWith('mo'));
  assert.deepEqual(matches.map((m) => m.name).sort(), ['model', 'models']);
});
