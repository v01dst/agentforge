import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  approveStagedWrite,
  listSkills,
  listSkillsSync,
  listStagedWrites,
  readSkillReference,
  rejectStagedWrite,
  renderSkillIndex,
  stageSkillWrite,
} from '../src/skills/skills.js';
import { createSkillManageTool, createSkillViewTool } from '../src/skills/tools.js';

const context = { runId: 'test', signal: new AbortController().signal } as never;

async function withTemp(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'af-skills-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function seedSkills(root: string): Promise<void> {
  await mkdir(join(root, '.agentforge', 'skills', 'deploy', 'references'), { recursive: true });
  await writeFile(
    join(root, '.agentforge', 'skills', 'deploy', 'SKILL.md'),
    ['---', 'name: deploy', 'description: Deployment runbook', '---', '', 'Step 1: build. Step 2: ship.'].join('\n'),
    'utf8',
  );
  await writeFile(join(root, '.agentforge', 'skills', 'deploy', 'references', 'rollback.md'), 'Rollback: revert and redeploy.', 'utf8');
  await writeFile(
    join(root, '.agentforge', 'skills', 'review.md'),
    ['---', 'name: review', 'description: Review changes carefully', '---', '', 'Check edge cases first.'].join('\n'),
    'utf8',
  );
}

test('both skill layouts are discovered: folders and flat files', async () => {
  await withTemp(async (root) => {
    await seedSkills(root);
    const skills = await listSkills(root);
    assert.deepEqual(skills.map((skill) => skill.name).sort(), ['deploy', 'review']);
    const deploy = skills.find((skill) => skill.name === 'deploy')!;
    assert.ok(deploy.dir, 'folder skill carries its directory');
    const review = skills.find((skill) => skill.name === 'review')!;
    assert.equal(review.dir, undefined);
    assert.deepEqual(listSkillsSync(root).map((skill) => skill.name).sort(), ['deploy', 'review']);
  });
});

test('skill index is compact: names and descriptions only', async () => {
  await withTemp(async (root) => {
    await seedSkills(root);
    const index = renderSkillIndex(await listSkills(root));
    assert.match(index!, /- deploy: Deployment runbook/);
    assert.match(index!, /- review: Review changes carefully/);
    assert.ok(!index!.includes('Step 1'), 'index must not leak full bodies');
  });
});

test('skill_view loads the body and reference files with escape protection', async () => {
  await withTemp(async (root) => {
    await seedSkills(root);
    const tool = createSkillViewTool({ root });
    const body = (await tool.execute({ name: 'deploy' }, context)) as { content: string; references: string[] };
    assert.match(body.content, /Step 1: build/);
    assert.deepEqual(body.references, ['references/rollback.md']);
    const reference = (await tool.execute({ name: 'deploy', path: 'references/rollback.md' }, context)) as { content: string };
    assert.match(reference.content, /Rollback/);
    await assert.rejects(() => tool.execute({ name: 'deploy', path: '../../outside.txt' }, context), /escapes/);
    await assert.rejects(() => tool.execute({ name: 'nope' }, context), /Unknown skill/);
  });
});

test('readSkillReference guards traversal without needing a tool', async () => {
  await withTemp(async (root) => {
    await seedSkills(root);
    const dir = join(root, '.agentforge', 'skills', 'deploy');
    assert.match(await readSkillReference(dir, 'references/rollback.md'), /Rollback/);
    await assert.rejects(() => readSkillReference(dir, '../review.md'), /escapes/);
  });
});

test('skill_manage applies directly when the gate is off', async () => {
  await withTemp(async (root) => {
    const tool = createSkillManageTool({ root });
    const created = (await tool.execute({ action: 'create', name: 'gitflow', content: 'Branch from main; PR to ship.' }, context)) as { staged: boolean; message: string };
    assert.equal(created.staged, false);
    const raw = await readFile(join(root, '.agentforge', 'skills', 'gitflow', 'SKILL.md'), 'utf8');
    assert.match(raw, /Branch from main/);
    const patched = (await tool.execute({ action: 'patch', name: 'gitflow', oldString: 'Branch from main', content: 'Branch from develop' }, context)) as { staged: boolean };
    assert.equal(patched.staged, false);
    assert.match(await readFile(join(root, '.agentforge', 'skills', 'gitflow', 'SKILL.md'), 'utf8'), /Branch from develop/);
  });
});

test('skill_manage stages writes when the gate is on; review flow applies or rejects', async () => {
  await withTemp(async (root) => {
    const tool = createSkillManageTool({ root, writeApproval: true });
    const staged = (await tool.execute({ action: 'create', name: 'release', content: 'Tag, changelog, publish.' }, context)) as { staged: boolean; id: string };
    assert.equal(staged.staged, true);
    assert.ok(staged.id);
    // Nothing applied yet.
    const before = await listSkills(root);
    assert.ok(!before.some((skill) => skill.name === 'release'));
    // Review: list, approve.
    const pending = await listStagedWrites(root);
    assert.equal(pending.length, 1);
    const message = await approveStagedWrite(staged.id, root);
    assert.match(message, /Created skill 'release'/);
    const skills = await listSkills(root);
    assert.ok(skills.some((skill) => skill.name === 'release'));
    assert.deepEqual(await listStagedWrites(root), []);

    // Reject flow removes the pending file without applying.
    const staged2 = (await tool.execute({ action: 'delete', name: 'release' }, context)) as { id: string };
    assert.ok(await rejectStagedWrite(staged2.id, root));
    const skills2 = await listSkills(root);
    assert.ok(skills2.some((skill) => skill.name === 'release'), 'rejected delete must not apply');
  });
});

test('stageSkillWrite validates names and the CLI review helpers round-trip', async () => {
  await withTemp(async (root) => {
    await assert.rejects(() => stageSkillWrite({ action: 'create', skill: '../evil', content: 'x' }, root), /Invalid skill name/);
    const id = await stageSkillWrite({ action: 'patch', skill: 'demo', oldString: 'a', content: 'b' }, root);
    const staged = await listStagedWrites(root);
    assert.equal(staged[0]!.id, id);
    assert.equal(staged[0]!.action, 'patch');
    await assert.rejects(() => approveStagedWrite('../../escape', root), /Invalid staged id/);
  });
});
