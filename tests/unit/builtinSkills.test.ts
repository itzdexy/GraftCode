import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_SKILL_NOTES, loadSkills, skillReadRoots } from '../../src/main/agent/skills';
import { skillsSection } from '../../src/main/agent/systemPrompt';
import { buildPaths } from '../../src/main/app/paths';
import { makeTempDir, writeFile } from '../support/tmp';

const BUILTIN = path.resolve(__dirname, '../../resources/skills');
const SKILL = path.join(BUILTIN, 'diagram-design');

function files(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}
const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

describe('the bundled diagram-design skill', () => {
  it("is upstream's folder at the pinned commit, unchanged", () => {
    const upstream = JSON.parse(fs.readFileSync(path.join(SKILL, 'UPSTREAM.json'), 'utf8')) as Record<string, string>;
    expect(upstream).toMatchObject({ repository: 'https://github.com/cathrynlavery/diagram-design', commit: '7a2e22170ee838e859d8142ba825d83f8b6375e6', version: '2.6.74' });
    const names = files(SKILL).filter((f) => f !== 'UPSTREAM.json').sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(sha(names.map((f) => `${sha(fs.readFileSync(path.join(SKILL, f)))}  ${f}\n`).join(''))).toBe(upstream.treeHash);
    for (const f of ['SKILL.md', 'LICENSE', 'THIRD_PARTY_LICENSES.md', 'references/style-guide.md', 'references/profiles.md', 'assets/template.html']) expect(names).toContain(f);
    expect(names.length).toBeGreaterThan(250);
    expect(fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8')).toMatch(/^---\r?\nname: diagram-design\r?\n/);
  });
});

const skill = (description: string): string => `---\nname: diagram-design\ndescription: ${description}\n---\nbody\n`;

describe('built-in skills', () => {
  it('give way to a user skill of the same name, and that to a project skill', () => {
    const home = makeTempDir();
    const project = makeTempDir();
    const mine = (): unknown[] => loadSkills(home, project, BUILTIN).filter((s) => s.name === 'diagram-design');
    expect(mine()).toMatchObject([{ scope: 'builtin', path: path.join(BUILTIN, 'diagram-design', 'SKILL.md'), note: BUILTIN_SKILL_NOTES['diagram-design'] }]);
    writeFile(home, 'skills/diagram-design/SKILL.md', skill('Mine'));
    expect(mine()).toMatchObject([{ scope: 'user', description: 'Mine', note: null }]);
    writeFile(project, '.graft/skills/diagram-design/SKILL.md', skill('Ours'));
    expect(mine()).toMatchObject([{ scope: 'project', description: 'Ours', note: null }]);
  });

  it('are none when the folder is missing', () => {
    expect(loadSkills(makeTempDir(), null, null)).toEqual([]);
    expect(loadSkills(makeTempDir(), null, path.join(makeTempDir(), 'gone'))).toEqual([]);
    expect(buildPaths(makeTempDir(), makeTempDir(), makeTempDir(), makeTempDir()).builtinSkills).toBeNull();
    expect(buildPaths(makeTempDir(), makeTempDir(), makeTempDir(), path.resolve(__dirname, '../../resources')).builtinSkills).toBe(BUILTIN);
  });

  it("put Graft's note on the line after the skill", () => {
    expect(skillsSection([{ name: 'diagram-design', description: 'Draws', path: '/x/SKILL.md', scope: 'builtin', note: 'N' }])).toBe(
      '# Skills\nSkills are instruction files for specialized tasks. When a task matches a skill, Read its SKILL.md first and follow it.\n- diagram-design: Draws (/x/SKILL.md)\n  N'
    );
    expect(BUILTIN_SKILL_NOTES['diagram-design']).toMatch(/^Graft's copy of this skill is read-only: never write inside its folder\. /);
    expect(BUILTIN_SKILL_NOTES['diagram-design']).toMatch(/as the skill's profiles\.md describes\.$/);
  });

  it('name the folders that are read without asking', () => {
    expect(skillReadRoots('/h', '/r/skills')).toEqual([path.join('/h', 'skills'), '/r/skills']);
    expect(skillReadRoots('/h', null)).toEqual([path.join('/h', 'skills')]);
  });
});
