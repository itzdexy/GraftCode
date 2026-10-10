import type { SessionKind } from './schemas/sessions';

/**
 * Built-in commands that work on a project: its files, its changes, its checks. A chat has
 * no project, so its command menu leaves them out, and the session says so when one is typed
 * there anyway.
 */
export const CODE_ONLY_COMMANDS: ReadonlySet<string> = new Set(['plan', 'init', 'review', 'security-review', 'explain', 'test', 'decompile', 'commit', 'pr', 'mission']);

/** The commands a session of this kind offers. A command the user wrote under one of these names is theirs, and stays. */
export function commandsFor<T extends { name: string; source: string }>(kind: SessionKind, commands: T[]): T[] {
  return kind === 'code' ? commands : commands.filter((command) => !(command.source === 'builtin' && CODE_ONLY_COMMANDS.has(command.name)));
}
