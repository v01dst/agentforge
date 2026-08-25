import React from 'react';
import { render } from 'ink-testing-library';
import { MarkdownText, parseInline } from '../src/ui/markdown.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('parseInline extracts code segments', () => {
  const segments = parseInline('run `npm test` now');
  assert.equal(segments.length, 3);
  assert.deepEqual(segments[1], { text: 'npm test', kind: 'code' });
});

test('parseInline extracts bold segments', () => {
  const segments = parseInline('this is **important** stuff');
  assert.ok(segments.some((s) => s.kind === 'bold' && s.text === 'important'));
});

test('plain text yields a single plain segment', () => {
  const segments = parseInline('no formatting here');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, 'plain');
});

test('renders fenced code block with gutter prefix', () => {
  const instance = render(React.createElement(MarkdownText, { text: '```js\nconsole.log(1)\n```' }));
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /│ console\.log\(1\)/);
  instance.unmount();
});

test('renders heading as bold text', () => {
  const instance = render(React.createElement(MarkdownText, { text: '## Summary\nbody' }));
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /Summary/);
  assert.doesNotMatch(frame, /##/);
  instance.unmount();
});

test('renders bullets with dot glyph', () => {
  const instance = render(React.createElement(MarkdownText, { text: '- first item' }));
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /• first item/);
  assert.doesNotMatch(frame, /^- first/);
  instance.unmount();
});

test('plain paragraph passes through unchanged', () => {
  const instance = render(React.createElement(MarkdownText, { text: 'just words here' }));
  assert.match(instance.lastFrame() ?? '', /just words here/);
  instance.unmount();
});
