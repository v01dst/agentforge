import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILT_IN_SKINS, DEFAULT_SKIN_NAME, listSkinNames, resolveSkin, saveSkinSelection, skinFilePath } from '../src/ui/skin.js';

const PALETTE_KEYS = Object.keys(BUILT_IN_SKINS[DEFAULT_SKIN_NAME]?.colors ?? {});

test('every built-in skin defines the full semantic palette with hex colors', () => {
  for (const name of listSkinNames()) {
    const skin = BUILT_IN_SKINS[name];
    assert.ok(skin, name);
    for (const key of PALETTE_KEYS) {
      const value = skin.colors[key as keyof typeof skin.colors];
      assert.match(String(value), /^#[0-9a-fA-F]{6}$/, `${name}.${key}`);
    }
  }
});

test('resolveSkin falls back to the default preset when no files exist', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agentforge-skin-'));
  try {
    const { skin, sources } = await resolveSkin({ cwd: project });
    assert.equal(skin.name, DEFAULT_SKIN_NAME);
    assert.equal(sources[0], `default:${DEFAULT_SKIN_NAME}`);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('project file overrides global; explicit name overrides both; palette merges', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agentforge-skin-'));
  const fakeHome = await mkdtemp(join(tmpdir(), 'agentforge-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    await mkdir(join(project, '.agentforge'), { recursive: true });
    await saveSkinSelection({ skin: 'midnight' }, project, false);
    await saveSkinSelection({ skin: 'paper' }, project, true);
    const fromFiles = await resolveSkin({ cwd: project });
    assert.equal(fromFiles.skin.name, 'midnight');

    await writeFile(skinFilePath(project), JSON.stringify({ skin: 'midnight', colors: { uiAccent: '#123456' } }));
    const merged = await resolveSkin({ cwd: project });
    assert.equal(merged.skin.name, 'midnight');
    assert.equal(merged.skin.colors.uiAccent, '#123456');
    assert.notEqual(merged.skin.colors.uiOk, '#123456');

    const explicit = await resolveSkin({ name: 'paper', cwd: project });
    assert.equal(explicit.skin.name, 'paper');
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(fakeHome, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test('unknown names in files or env fall back safely to a built-in', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agentforge-skin-'));
  const fakeHome = await mkdtemp(join(tmpdir(), 'agentforge-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  const previous = process.env.AGENTFORGE_SKIN;
  try {
    await mkdir(join(project, '.agentforge'), { recursive: true });
    await writeFile(join(project, '.agentforge', 'skin.json'), JSON.stringify({ skin: 'neon-rainbow' }));
    const withoutEnv = await resolveSkin({ cwd: project });
    assert.equal(withoutEnv.skin.name, DEFAULT_SKIN_NAME);

    process.env.AGENTFORGE_SKIN = 'also-not-real';
    const stillSafe = await resolveSkin({ cwd: project });
    assert.equal(stillSafe.skin.name, DEFAULT_SKIN_NAME);
  } finally {
    if (previous === undefined) delete process.env.AGENTFORGE_SKIN;
    else process.env.AGENTFORGE_SKIN = previous;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(fakeHome, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test('saveSkinSelection round-trips through resolveSkin (global file)', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agentforge-skin-'));
  const fakeHome = await mkdtemp(join(tmpdir(), 'agentforge-home-'));
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    await saveSkinSelection({ skin: 'forge' }, project, true);
    const raw = JSON.parse(await readFile(skinFilePath(project, true), 'utf8')) as { skin?: string };
    assert.equal(raw.skin, 'forge');
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(fakeHome, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});
