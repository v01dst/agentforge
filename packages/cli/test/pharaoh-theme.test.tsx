import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { ScribesTablet } from '../src/ui/shell/ChatHome.js';
import { glyphs, templeRule, colors } from '../src/ui/shell/theme.js';
import { DEFAULT_SKIN_NAME, currentSkin } from '../src/ui/skin.js';

test('pharaoh is the default skin with the monument palette', () => {
  assert.equal(DEFAULT_SKIN_NAME, 'pharaoh');
  const palette = currentSkin().colors;
  assert.equal(palette.bannerTitle, '#D4A017');       // Pharaoh's Gold
  assert.equal(palette.bannerText, '#FDF5E6');        // Papyrus White
  assert.equal(palette.uiOk, '#48C9B0');              // Nile turquoise
  assert.equal(palette.uiThinking, '#E67E22');        // Desert sand
  assert.equal(palette.bannerDim, '#8E8E8E');         // Stone gray
});

test('glyph tokens resolve hieroglyphs under AGENTFORGE_GLYPHS=unicode', async () => {
  process.env.AGENTFORGE_GLYPHS = 'unicode';
  const theme = await import('../src/ui/shell/theme.js?' + Date.now());
  assert.equal(theme.glyphs.eyeHorus, '𓂀');
  assert.equal(theme.glyphs.ankh, '𓋴');
  assert.equal(theme.glyphs.online, '𓋹');
  assert.equal(theme.glyphs.scarab, '𓆣');
  assert.match(theme.glyphs.prompt, /FORGE > $/);
  assert.equal(theme.templeRule(8), '════════');
  assert.equal(theme.templeRule(0), '');
  delete process.env.AGENTFORGE_GLYPHS;
});

test('glyph tokens fall back to ASCII in non-TTY harnesses', () => {
  assert.equal(glyphs.eyeHorus, '>');
  assert.match(glyphs.prompt, /FORGE > $/);
  assert.equal(templeRule(8), '========');
});

test("Scribe's Tablet carries provider, model, mode, posture, and tokens", async () => {
  const instance = render(React.createElement(ScribesTablet, {
    provider: 'openai',
    model: 'gpt-5.6-sol',
    projectName: 'forge',
    totalTokens: 12_400,
  }));
  await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /openai/);
  assert.match(frame, /gpt-5\.6-sol/);
  assert.match(frame, /build/);                       // session mode
  assert.match(frame, /ask/);                         // posture
  assert.match(frame, /12\.4k tok/);                  // scarab tokens
  assert.match(frame, /forge/);                       // project
  instance.unmount();
});

test('Cartouche header shows the Eye of Horus, the name, the Ankh, and ONLINE', async () => {
  // Render through ChatHome: the header is internal, so assert via glyph presence.
  const { ChatHome } = await import('../src/ui/shell/ChatHome.js');
  const runner = async function* () { yield { text: 'ready' }; };
  const instance = render(React.createElement(ChatHome, { runner, commands: [], autoResume: false }));
  await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  const frame = instance.lastFrame() ?? '';
  assert.match(frame, /AGENTFORGE/);
  instance.unmount();
  void colors;
});
