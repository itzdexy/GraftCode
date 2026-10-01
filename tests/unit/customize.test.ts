import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCustomCommands } from '../../src/main/agent/slashCommands';
import { loadSkills } from '../../src/main/agent/skills';
import { deleteCommand, deleteSkill, listCommands, listMemory, listSkills, saveCommand, saveMemory, saveSkill } from '../../src/main/customize/customize';
import { makeTempDir, removeDir, writeFile } from '../support/tmp';

describe('customize files', () => {
  it('saves commands with front matter that the command loader reads back', async () => {
    const home = makeTempDir();
    const project = makeTempDir();
    const file = await saveCommand(home, {
      scope: 'project',
      projectRoot: project,
      name: 'release',
      description: 'Run the release: checklist',
      argumentHint: '<version>',
      body: 'Release version $ARGUMENTS.',
      previousPath: null
    });
    expect(file).toBe(path.join(project, '.graft', 'commands', 'release.md'));
    const loaded = loadCustomCommands(home, project).find((c) => c.name === 'release');
    expect(loaded).toMatchObject({ description: 'Run the release: checklist', argumentHint: '<version>', source: 'project' });
    expect(listCommands(home, project)).toHaveLength(1);

    // Renaming moves the file.
    const renamed = await saveCommand(home, { scope: 'project', projectRoot: project, name: 'ship', description: 'Ship it', argumentHint: null, body: 'Ship.', previousPath: file });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(renamed)).toBe(true);
    await deleteCommand(home, project, renamed);
    expect(listCommands(home, project)).toHaveLength(0);
    removeDir(home);
    removeDir(project);
  });

  it('rejects built-in names, bad names and files outside the command folders', async () => {
    const home = makeTempDir();
    const outside = writeFile(makeTempDir(), 'notes.md', 'keep me');
    await expect(saveCommand(home, { scope: 'user', projectRoot: null, name: 'compact', description: '', argumentHint: null, body: 'x', previousPath: null })).rejects.toMatchObject({ code: 'reserved_name' });
    await expect(saveCommand(home, { scope: 'user', projectRoot: null, name: '../evil', description: '', argumentHint: null, body: 'x', previousPath: null })).rejects.toMatchObject({ code: 'invalid_name' });
    await expect(deleteCommand(home, null, outside)).rejects.toMatchObject({ code: 'outside_folder' });
    expect(fs.existsSync(outside)).toBe(true);
    removeDir(home);
  });

  it('saves skills as <name>/SKILL.md and deletes only skill folders', async () => {
    const home = makeTempDir();
    const file = await saveSkill(home, { scope: 'user', projectRoot: null, name: 'pdf-forms', description: 'Fill PDF forms', body: '# Steps\n1. Do it', previousPath: null });
    expect(file).toBe(path.join(home, 'skills', 'pdf-forms', 'SKILL.md'));
    expect(loadSkills(home, null)).toMatchObject([{ name: 'pdf-forms', description: 'Fill PDF forms', scope: 'user' }]);
    expect(listSkills(home, null)[0]?.body).toBe('# Steps\n1. Do it\n');
    await expect(saveSkill(home, { scope: 'user', projectRoot: null, name: 'x', description: '  ', body: '', previousPath: null })).rejects.toMatchObject({ code: 'description_required' });
    await expect(deleteSkill(home, null, path.join(home, 'settings.json'))).rejects.toMatchObject({ code: 'outside_folder' });
    await deleteSkill(home, null, file);
    expect(fs.existsSync(path.dirname(file))).toBe(false);
    removeDir(home);
  });

  it('edits GRAFT.md and points out fallback instruction files', async () => {
    const home = makeTempDir();
    const project = makeTempDir();
    writeFile(project, 'AGENTS.md', 'old instructions');
    let memory = listMemory(home, project);
    expect(memory.map((m) => [m.scope, m.exists, m.fallback ? path.basename(m.fallback) : null])).toEqual([
      ['user', false, null],
      ['project', false, 'AGENTS.md']
    ]);
    await saveMemory(home, 'project', project, '# Project rules');
    memory = listMemory(home, project);
    expect(memory[1]).toMatchObject({ exists: true, content: '# Project rules\n', fallback: null });
    removeDir(home);
    removeDir(project);
  });
});
