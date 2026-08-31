import { z } from 'zod';
import { defineTool } from '@agentforge-oss/tools';
import { approveStagedWrite, listSkillReferences, listSkills, readSkillReference, stageSkillWrite, type SkillWriteAction, type StagedSkillWrite } from './skills.js';

export interface SkillToolOptions {
  root: string;
  global?: boolean;
  /**
   * When true, skill_manage writes are staged for review instead of applied
   * (Phase B write-approval gate). When false, writes apply immediately and
   * the ordinary permission posture still gates the tool call.
   */
  writeApproval?: boolean;
}

/** Progressive disclosure level 1/2: load a skill body or a reference file. */
export function createSkillViewTool(options: SkillToolOptions) {
  return defineTool({
    name: 'skill_view',
    description: 'Load an available skill: the full SKILL.md body (level 1) or one reference file inside the skill folder (level 2).',
    permissions: ['filesystem:read'],
    timeoutMs: 10_000,
    input: z.object({
      name: z.string(),
      /** Reference file relative to the skill folder (level 2); omit for the body. */
      path: z.string().optional(),
    }),
    output: z.object({
      name: z.string(),
      content: z.string(),
      references: z.array(z.string()),
    }),
    async execute(input) {
      const skills = await listSkills(options.root);
      const skill = skills.find((candidate) => candidate.name === input.name);
      if (!skill) {
        throw new Error(`Unknown skill: ${input.name}. Available: ${skills.map((skill) => skill.name).join(', ') || '(none)'}`);
      }
      if (input.path) {
        if (!skill.dir) throw new Error(`Skill '${skill.name}' is a flat file and has no reference files.`);
        return { name: skill.name, content: await readSkillReference(skill.dir, input.path), references: await listSkillReferences(skill.dir) };
      }
      if (skill.body === undefined) throw new Error(`Skill '${skill.name}' has no body.`);
      const references = skill.dir ? await listSkillReferences(skill.dir) : [];
      return { name: skill.name, content: skill.body, references };
    },
  });
}

const manageInput = z.object({
  action: z.enum(['create', 'patch', 'delete', 'write_file']),
  name: z.string(),
  content: z.string().optional(),
  /** patch: the exact text to replace in SKILL.md. */
  oldString: z.string().optional(),
  /** write_file: target path inside the skill folder. */
  filePath: z.string().optional(),
});

/**
 * Agent-authored skills (procedural memory). With writeApproval the write is
 * staged in .agentforge/pending/skills/ for review; otherwise it applies at
 * once under the caller's permission posture.
 */
export function createSkillManageTool(options: SkillToolOptions) {
  return defineTool({
    name: 'skill_manage',
    description:
      'Create, improve, or remove your own skills (procedural memory). Prefer patch for targeted fixes. Writes may be staged for human review depending on configuration.',
    permissions: ['filesystem:write'],
    timeoutMs: 10_000,
    input: manageInput,
    output: z.object({
      staged: z.boolean(),
      id: z.string().optional(),
      message: z.string(),
    }),
    async execute(input) {
      const scope = options.global ? undefined : options.root;
      const effectiveCwd = scope ?? process.cwd();
      if (options.writeApproval) {
        const proposal: Omit<StagedSkillWrite, 'id' | 'createdAt'> = {
          action: input.action as SkillWriteAction,
          skill: input.name,
          content: input.content,
          oldString: input.oldString,
          filePath: input.filePath,
        };
        const id = await stageSkillWrite(proposal, effectiveCwd);
        return { staged: true, id, message: `Staged ${input.action} for skill '${input.name}' as ${id}. A human can review it with: agentforge skills diff ${id}` };
      }
      // Direct apply (same code path as approving a staged write).
      const id = await stageSkillWrite(
        { action: input.action as SkillWriteAction, skill: input.name, content: input.content, oldString: input.oldString, filePath: input.filePath },
        effectiveCwd,
      );
      const message = await approveStagedWrite(id, effectiveCwd);
      return { staged: false, message };
    },
  });
}
