import path from 'node:path';

/**
 * Skills, slash commands and agents that other coding tools keep in their own
 * folders (.claude, .cursor, .codex). Graft reads them as well as its own and
 * never writes there. A project's folders count only once the project is
 * trusted, as its .graft settings do; on a name clash Graft's own item wins
 * (each loader reads these roots first, so its own folders replace them).
 */

export interface OtherRoot {
  dir: string;
  scope: 'user' | 'project';
}

export interface OtherToolRoots {
  skills: OtherRoot[];
  commands: OtherRoot[];
  agents: OtherRoot[];
}

export const NO_OTHER_ROOTS: OtherToolRoots = { skills: [], commands: [], agents: [] };

/** What a folder of another tool holds, or nothing when it can't be read: a folder Graft doesn't own never stops a session. */
export function readOther<T>(read: () => T[]): T[] {
  try {
    return read();
  } catch {
    return [];
  }
}

/** The folders to read, each list from the one that gives way first: the user's before the project's. */
export function otherToolRoots(options: { enabled: boolean; home: string; projectRoot: string | null; trusted: boolean }): OtherToolRoots {
  if (!options.enabled) return NO_OTHER_ROOTS;
  const project = options.trusted ? options.projectRoot : null;
  const user = (...parts: string[]): OtherRoot => ({ dir: path.join(options.home, ...parts), scope: 'user' });
  const own = (...parts: string[]): OtherRoot[] => (project ? [{ dir: path.join(project, ...parts), scope: 'project' }] : []);
  return {
    skills: [user('.claude', 'skills'), ...own('.claude', 'skills')],
    commands: [user('.codex', 'prompts'), user('.claude', 'commands'), ...own('.cursor', 'commands'), ...own('.claude', 'commands')],
    agents: [user('.claude', 'agents'), ...own('.claude', 'agents')]
  };
}
