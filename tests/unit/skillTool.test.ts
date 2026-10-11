import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SKILL_READ_MAX, skillTool } from '../../src/main/tools/skillTool';
import { makeTempDir, writeFile } from '../support/tmp';
import { makeToolContext } from '../support/toolContext';

const BUILTIN = path.resolve(__dirname, '../../resources/skills');
const ctx = (builtinSkills: string | null = BUILTIN) => makeToolContext(makeTempDir(), { builtinSkills });
const text = (r: { content: Array<{ type: string; text?: string }> }): string => r.content.map((c) => c.text ?? '').join('');

describe('Skill', () => {
  it('reads a skill, and a file the skill points to', async () => {
    expect(text(await skillTool.execute({ name: 'diagram-design' }, ctx()))).toMatch(/^---\r?\nname: diagram-design/);
    expect(text(await skillTool.execute({ name: 'diagram-design', file: 'assets/template.html' }, ctx()))).toContain('<svg viewBox="0 0 960 600"');
  });

  it('says what it could not read', async () => {
    const no = async (input: { name: string; file?: string }, c = ctx()) => {
      const result = await skillTool.execute(input, c);
      expect(result.isError).toBe(true);
      return text(result);
    };
    expect(await no({ name: 'nope' })).toBe('No built-in skill is named "nope". Built in: diagram-design.');
    expect(await no({ name: 'diagram-design', file: 'references/nope.md' })).toBe('references/nope.md is not in the diagram-design skill.');
    expect(await no({ name: 'diagram-design', file: '../../package.json' })).toBe('That path is outside the skill.');
    expect(await no({ name: 'diagram-design', file: path.resolve(BUILTIN, '..', 'fonts', 'OFL.txt') })).toBe('That path is outside the skill.');
    expect(await no({ name: 'diagram-design' }, ctx(null))).toBe('No built-in skill is named "diagram-design". Built in: none.');
    // A folder is not a file to read, and neither is a picture.
    expect(await no({ name: 'diagram-design', file: 'references' })).toBe('references is not in the diagram-design skill.');
  });

  it('cuts a long file and says so, and refuses what is not text', async () => {
    const skills = makeTempDir();
    writeFile(skills, 'big/SKILL.md', '---\nname: big\ndescription: d\n---\n');
    writeFile(skills, 'big/long.md', 'a'.repeat(SKILL_READ_MAX + 10));
    writeFile(skills, 'big/picture.bin', Buffer.from([1, 2, 0, 3]));
    const out = text(await skillTool.execute({ name: 'big', file: 'long.md' }, ctx(skills)));
    expect(out.startsWith('a'.repeat(SKILL_READ_MAX))).toBe(true);
    expect(out.endsWith('\n[Cut at 256 KB; the file is 256 KB.]')).toBe(true);
    const binary = await skillTool.execute({ name: 'big', file: 'picture.bin' }, ctx(skills));
    expect(binary.isError).toBe(true);
    expect(text(binary)).toBe('picture.bin is not a text file.');
  });

  it('never asks and never changes anything', async () => {
    expect(skillTool.permissionClass).toBe('none');
    expect(skillTool.concurrencySafe({ name: 'diagram-design' })).toBe(true);
    expect((await skillTool.describe({ name: 'diagram-design', file: 'references/type-flowchart.md' }, ctx())).summary).toBe('Reading references/type-flowchart.md of the diagram-design skill');
  });
});
