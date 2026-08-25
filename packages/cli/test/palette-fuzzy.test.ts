import assert from 'node:assert/strict';
import test from 'node:test';
import { fuzzyMatch, fuzzyScore } from '../src/ui/shell/palette.tsx';

test('fuzzyMatch: subsequence matching', () => {
  assert.equal(fuzzyMatch('cnct', 'connect'), true);
  assert.equal(fuzzyMatch('xyz', 'connect'), false);
});

test('fuzzyMatch: case-insensitive', () => {
  assert.equal(fuzzyMatch('CNCT', 'Connect'), true);
});

test('empty query matches everything', () => {
  assert.equal(fuzzyMatch('', 'anything'), true);
  assert.equal(fuzzyScore('', 'anything'), 0);
});

test('fuzzyScore: non-match returns -1', () => {
  assert.equal(fuzzyScore('xyz', 'connect'), -1);
});

test('fuzzyScore: prefix beats scattered subsequence', () => {
  assert.ok(fuzzyScore('mo', 'models') > fuzzyScore('omdels', 'models'));
});

test('fuzzyScore: prefix ranks highest overall', () => {
  // prefix match should beat word-boundary and plain subsequence matches
  assert.ok(
    fuzzyScore('mo', 'models') > fuzzyScore('mo', 'run models') &&
    fuzzyScore('mo', 'models') > fuzzyScore('mo', 'some random models list')
  );
});
