import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { scanBuiltinSkills } from '../agent/skills';
import { looksBinary } from './fs/read';
import { isInsideReal } from './paths';
import { errorResult, textResult, type ToolDefinition } from './types';

/**
 * Reads the skills that ship with Graft, for chats: a chat has no file tools,
 * so this is how it follows a skill (a code session reads the same files with
 * Read). Built-in skills only, never the user's or a project's, and nothing
 * but text inside the skill's own folder.
 */

/** At most this much of a file comes back from one call. */
export const SKILL_READ_MAX = 256 * 1024;

const SkillInput = z.object({
  name: z.string().min(1).max(100).describe('The built-in skill to read, such as "diagram-design".'),
  file: z
    .string()
    .min(1)
    .max(400)
    .optional()
    .describe('One of the files the skill points to, as a path inside the skill (references/type-flowchart.md). Left out: the skill itself, its SKILL.md.')
});
type SkillInput = z.infer<typeof SkillInput>;

/** A size as the file cards say it: whole KB below 1 MB, one decimal of MB above. */
function sizeText(bytes: number): string {
  return bytes < 1024 * 1024 ? `${String(Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const skillTool: ToolDefinition<SkillInput> = {
  name: 'Skill',
  description:
    'Reads a built-in skill: its SKILL.md, or with file one of the files it points to (a path inside the skill, such as references/type-flowchart.md). Read-only.',
  input: SkillInput,
  permissionClass: 'none',
  concurrencySafe: () => true,
  timeoutMs: 30_000,
  describe(input) {
    const summary = input.file ? `Reading ${input.file} of the ${input.name} skill` : `Reading the ${input.name} skill`;
    return Promise.resolve({ summary, preview: { kind: 'generic', text: summary } });
  },
  execute(input, ctx) {
    const skills = scanBuiltinSkills(ctx.builtinSkills);
    const skill = skills.find((s) => s.name === input.name);
    if (!skill) {
      const names = skills.map((s) => s.name).join(', ') || 'none';
      return Promise.resolve(errorResult(`No built-in skill is named "${input.name}". Built in: ${names}.`));
    }
    const folder = path.dirname(skill.path);
    // An absolute path is taken as given, so it is outside unless it really is inside.
    const file = input.file === undefined ? skill.path : path.resolve(folder, input.file);
    const shown = input.file ?? 'SKILL.md';
    if (!isInsideReal(folder, file, ctx.platform)) return Promise.resolve(errorResult('That path is outside the skill.'));
    let data: Buffer;
    let size: number;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) throw new Error('not a file');
      size = stat.size;
      const handle = fs.openSync(file, 'r');
      try {
        data = Buffer.alloc(Math.min(size, SKILL_READ_MAX));
        fs.readSync(handle, data, 0, data.length, 0);
      } finally {
        fs.closeSync(handle);
      }
    } catch {
      return Promise.resolve(errorResult(`${shown} is not in the ${skill.name} skill.`));
    }
    if (looksBinary(data)) return Promise.resolve(errorResult(`${shown} is not a text file.`));
    // A cut may fall inside a character; what is left of it is dropped rather than shown as a broken one.
    const text = data.toString('utf8').replace(/\uFFFD+$/, '');
    const cut = size > SKILL_READ_MAX ? `\n[Cut at ${sizeText(SKILL_READ_MAX)}; the file is ${sizeText(size)}.]` : '';
    return Promise.resolve(textResult(text + cut, { kind: 'text', text: `${shown} of the ${skill.name} skill (${sizeText(size)})` }));
  }
};
