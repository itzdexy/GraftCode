import { describe, expect, it } from 'vitest';
import { commandSuggestions } from '../../../src/renderer/src/features/composer/suggestions';
import { CODE_ONLY_COMMANDS, commandsFor } from '../../../src/shared/commands';
import type { SlashCommand } from '../../../src/shared/schemas/app';

/** The built-in commands in the catalogue's order, as `commands:list` hands them over. */
const CATALOGUE = [
  ['clear', null],
  ['compact', '[what to keep]'],
  ['model', '[model]'],
  ['effort', '[low|medium|high|extra|max|taproot]'],
  ['permissions', '[ask|auto-edit|plan|auto]'],
  ['plan', '[what to plan]'],
  ['mcp', null],
  ['init', null],
  ['review', '[focus]'],
  ['security-review', '[focus]'],
  ['explain', '[file, folder or feature]'],
  ['research', '[question]'],
  ['test', '[what to test]'],
  ['decompile', '[function, file or binary]'],
  ['commit', '[hint]'],
  ['pr', '[hint]'],
  ['mission', '[objective]'],
  ['resume', null],
  ['new', null],
  ['cost', null],
  ['context', null],
  ['rewind', null],
  ['export', null],
  ['system', null],
  ['help', null],
  ['config', null]
] as const;
const builtins: SlashCommand[] = CATALOGUE.map(([name, argumentHint]) => ({ name, description: `What /${name} does`, argumentHint, source: 'builtin', path: null }));
const names = (commands: SlashCommand[], query: string): string[] => commandSuggestions(commands, query).map((s) => s.label.split(' ')[0] ?? '');

describe('the / menu', () => {
  it('lists every command, in the catalogue’s order, while nothing is typed after the /', () => {
    const listed = names(builtins, '');
    expect(listed).toHaveLength(26);
    expect(listed).toEqual(builtins.map((c) => `/${c.name}`));
    // The user's own commands follow the built-in ones, as they are given.
    const own: SlashCommand = { name: 'deploy', description: 'Ship it', argumentHint: null, source: 'user', path: 'C:/home/.graft/commands/deploy.md' };
    expect(names([...builtins, own], '').at(-1)).toBe('/deploy');
  });

  it('ranks and shortens the list once something is typed', () => {
    expect(names(builtins, 'e').length).toBe(12);
    // Among names that start with what was typed, the shorter comes first.
    expect(names(builtins, 'res')).toEqual(['/resume', '/research']);
    expect(names(builtins, 'zzz')).toEqual([]);
  });

  it('offers a chat the commands a chat can use: /research is there, the ones that work on a project are not', () => {
    const chat = names(commandsFor('chat', builtins), '');
    expect(chat).toEqual(expect.arrayContaining(['/research', '/context', '/compact', '/clear', '/model', '/cost', '/help']));
    for (const gone of CODE_ONLY_COMMANDS) expect(chat).not.toContain(`/${gone}`);
    expect(chat).toHaveLength(26 - CODE_ONLY_COMMANDS.size);
    // A code session keeps them all.
    expect(names(commandsFor('code', builtins), '')).toHaveLength(26);
  });
});
