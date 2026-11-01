import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAgents } from '../../src/main/agent/agents';
import { otherToolRoots } from '../../src/main/agent/otherTools';
import { skillReadRoots, loadSkills } from '../../src/main/agent/skills';
import { expandCommand, listCommands, loadCustomCommands } from '../../src/main/agent/slashCommands';
import { deleteCommand, listAgents, listCommands as listCommandFiles, listSkills } from '../../src/main/customize/customize';
import { makeTempDir, removeDir, writeFile } from '../support/tmp';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(removeDir));

function temp(): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return dir;
}

/** A home folder with another tool's files, Graft's own home, and a project. */
function setup(): { home: string; graftHome: string; project: string } {
  return { home: temp(), graftHome: temp(), project: temp() };
}

describe("other tools' folders", () => {
  it('reads the home folder always and a project only once it is trusted, and nothing when turned off', () => {
    const { home, project } = setup();
    const trusted = otherToolRoots({ enabled: true, home, projectRoot: project, trusted: true });
    expect(trusted.commands).toEqual([
      { dir: path.join(home, '.codex', 'prompts'), scope: 'user' },
      { dir: path.join(home, '.claude', 'commands'), scope: 'user' },
      { dir: path.join(project, '.cursor', 'commands'), scope: 'project' },
      { dir: path.join(project, '.claude', 'commands'), scope: 'project' }
    ]);
    expect(trusted.skills.map((r) => r.dir)).toEqual([path.join(home, '.claude', 'skills'), path.join(project, '.claude', 'skills')]);
    expect(trusted.agents.map((r) => r.dir)).toEqual([path.join(home, '.claude', 'agents'), path.join(project, '.claude', 'agents')]);

    const untrusted = otherToolRoots({ enabled: true, home, projectRoot: project, trusted: false });
    expect([...untrusted.commands, ...untrusted.skills, ...untrusted.agents].every((r) => r.scope === 'user')).toBe(true);

    expect(otherToolRoots({ enabled: false, home, projectRoot: project, trusted: true })).toEqual({ skills: [], commands: [], agents: [] });
  });

  it("offers another tool's commands, and Graft's own command or built-in wins a clash", () => {
    const { home, graftHome, project } = setup();
    writeFile(project, '.claude/commands/hello.md', '---\ndescription: Say hello\n---\nSay hello to $ARGUMENTS.');
    writeFile(project, '.claude/commands/frontend/component.md', 'Make a component called $1.');
    writeFile(project, '.cursor/commands/tidy.md', 'Tidy up this file.');
    writeFile(home, '.codex/prompts/explain-diff.md', 'Explain the diff of $1 against $2.');
    writeFile(home, '.claude/commands/hello.md', 'The user-level hello.');
    // Graft's own, and two built-ins: one that sends a prompt, one that runs the session.
    writeFile(graftHome, 'commands/tidy.md', "Graft's own tidy.");
    writeFile(project, '.claude/commands/review.md', 'Another review.');
    writeFile(project, '.claude/commands/clear.md', 'Not a clear.');
    const others = otherToolRoots({ enabled: true, home, projectRoot: project, trusted: true }).commands;

    const loaded = loadCustomCommands(graftHome, project, others);
    expect(loaded.map((c) => c.name)).toEqual(['explain-diff', 'frontend:component', 'hello', 'tidy']);
    expect(loaded.find((c) => c.name === 'hello')).toMatchObject({ source: 'project', imported: true, description: 'Say hello' });
    expect(loaded.find((c) => c.name === 'tidy')).toMatchObject({ source: 'user', body: "Graft's own tidy." });
    expect(loaded.find((c) => c.name === 'tidy')?.imported).toBeUndefined();

    // The "/" menu: the built-in /review stays, and nothing of another tool's carries its body there.
    const menu = listCommands(graftHome, project, others);
    expect(menu.find((c) => c.name === 'review')?.source).toBe('builtin');
    expect(menu.find((c) => c.name === 'hello')).toEqual({ name: 'hello', description: 'Say hello', argumentHint: null, source: 'project', path: path.join(project, '.claude', 'commands', 'hello.md') });

    // Without trust only the home folder's are read.
    const untrusted = loadCustomCommands(graftHome, project, otherToolRoots({ enabled: true, home, projectRoot: project, trusted: false }).commands);
    expect(untrusted.find((c) => c.name === 'hello')?.body).toBe('The user-level hello.');
    expect(untrusted.some((c) => c.name === 'frontend:component')).toBe(false);
  });

  it('fills in the arguments the way each tool writes them', () => {
    const { home, graftHome, project } = setup();
    writeFile(project, '.claude/commands/hello.md', 'Say hello to $ARGUMENTS.');
    writeFile(project, '.cursor/commands/tidy.md', 'Tidy up this file.');
    writeFile(home, '.codex/prompts/compare.md', 'Compare $1 with $2.');
    const loaded = loadCustomCommands(graftHome, project, otherToolRoots({ enabled: true, home, projectRoot: project, trusted: true }).commands);
    const run = (name: string, args: string): string => expandCommand(loaded.find((c) => c.name === name)!, args);
    expect(run('hello', 'the team')).toBe('Say hello to the team.');
    expect(run('compare', 'main feature')).toBe('Compare main with feature.');
    // A command that names no arguments gets them at the end.
    expect(run('tidy', 'src/app.ts')).toBe('Tidy up this file.\n\nsrc/app.ts');
  });

  it("reads another tool's skills and agents below Graft's own, and lets the agent read those skills without asking", () => {
    const { home, graftHome, project } = setup();
    writeFile(home, '.claude/skills/pdf/SKILL.md', '---\nname: pdf\ndescription: Fill PDF forms\n---\nSteps.');
    writeFile(home, '.claude/skills/shared/SKILL.md', '---\nname: shared\ndescription: Theirs\n---\nTheirs.');
    writeFile(graftHome, 'skills/shared/SKILL.md', '---\nname: shared\ndescription: Ours\n---\nOurs.');
    writeFile(project, '.claude/agents/reviewer.md', '---\ndescription: Reviews diffs\ntools: Read, Grep\n---\nYou review.');
    writeFile(graftHome, 'agents/writer.md', '---\ndescription: Writes\n---\nYou write.');
    const roots = otherToolRoots({ enabled: true, home, projectRoot: project, trusted: true });

    const skills = loadSkills(graftHome, project, null, roots.skills);
    expect(skills.map((s) => [s.name, s.description, s.imported === true])).toEqual([
      ['pdf', 'Fill PDF forms', true],
      ['shared', 'Ours', false]
    ]);
    expect(skillReadRoots(graftHome, null, roots.skills)).toContain(path.join(home, '.claude', 'skills'));

    const agents = loadAgents(graftHome, project, roots.agents);
    expect(agents.map((a) => [a.name, a.source, a.imported === true])).toEqual([
      ['reviewer', 'project', true],
      ['writer', 'user', false]
    ]);
    expect(agents[0]?.tools).toEqual(['Read', 'Grep']);
  });

  it('a folder that cannot be read or a file that is not a skill is passed over', () => {
    const { home, graftHome } = setup();
    // ".claude/skills" is a file here, and ".claude/agents" holds something that isn't an agent.
    writeFile(home, '.claude/skills', 'not a folder');
    writeFile(home, '.claude/agents/notes.txt', 'hello');
    const roots = otherToolRoots({ enabled: true, home, projectRoot: null, trusted: false });
    expect(loadSkills(graftHome, null, null, roots.skills)).toEqual([]);
    expect(loadAgents(graftHome, null, roots.agents)).toEqual([]);
  });

  it('Customize lists them as imported, with their path, and never deletes them', async () => {
    const { home, graftHome, project } = setup();
    const file = writeFile(project, '.claude/commands/hello.md', 'Say hello.');
    writeFile(home, '.claude/skills/pdf/SKILL.md', '---\nname: pdf\ndescription: Fill PDF forms\n---\nSteps.');
    writeFile(home, '.claude/agents/reviewer.md', '---\ndescription: Reviews\n---\nYou review.');
    const roots = otherToolRoots({ enabled: true, home, projectRoot: project, trusted: true });
    expect(listCommandFiles(graftHome, project, roots.commands)).toEqual([{ name: 'hello', description: 'Say hello.', argumentHint: null, scope: 'project', path: file, body: 'Say hello.', imported: true }]);
    expect(listSkills(graftHome, project, null, roots.skills)[0]).toMatchObject({ name: 'pdf', imported: true, scope: 'user' });
    expect(listAgents(graftHome, project, roots.agents)[0]).toMatchObject({ name: 'reviewer', imported: true });
    await expect(deleteCommand(graftHome, project, file)).rejects.toMatchObject({ code: 'outside_folder' });
  });
});
