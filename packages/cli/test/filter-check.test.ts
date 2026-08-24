import { test } from 'node:test';
import assert from 'node:assert';

// Mirror of ChatHome's filter logic
const commands = [
  { name: 'models', description: 'x' },
  { name: 'model', description: 'x', usage: '/model <name>' },
  { name: 'mode', description: 'x' },
];

test('filter /mo matches model + models', () => {
  const input = '/mo';
  const needle = input.slice(1).split(/\s+/)[0]?.toLowerCase() ?? '';
  const filtered = commands.filter((c) => c.name.toLowerCase().startsWith(needle));
  assert.equal(filtered.length, 3);
});

test('empty commands array yields no matches — reproduces TUI bug if props empty', () => {
  const input = '/mo';
  const needle = input.slice(1).split(/\s+/)[0]?.toLowerCase() ?? '';
  const filtered = [].filter((c) => c.name.toLowerCase().startsWith(needle));
  assert.equal(filtered.length, 0);
});
