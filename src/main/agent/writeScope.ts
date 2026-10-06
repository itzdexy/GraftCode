import path from 'node:path';
import picomatch from 'picomatch';
import { normalizeScope } from '@shared/writeScopes';

/** Keeps an agent of a group to the paths it was given (see shared/writeScopes.ts for how paths are compared). */

const WILDCARD = /[*?[\]{}]/;

/** Whether a file (relative to the project) is one the scopes allow: the file itself, anything under a folder, or what a pattern names. */
export function inScope(file: string, scopes: string[], platform: NodeJS.Platform = process.platform): boolean {
  const nocase = platform === 'win32' || platform === 'darwin';
  const fold = (text: string): string => (nocase ? text.toLowerCase() : text);
  const target = normalizeScope(file);
  return scopes.some((raw) => {
    const scope = normalizeScope(raw);
    if (WILDCARD.test(scope)) return picomatch(scope, { dot: true, nocase })(target);
    return fold(target) === fold(scope) || fold(target).startsWith(`${fold(scope)}/`);
  });
}

/** The files a tool call would change that the scopes don't allow, as paths in the project (or in full when they are outside it). */
export function outsideScope(files: string[], scopes: string[], projectRoot: string, platform: NodeJS.Platform = process.platform): string[] {
  const out: string[] = [];
  for (const file of files) {
    const rel = path.relative(projectRoot, file);
    const inside = rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
    const shown = inside ? rel.split(path.sep).join('/') : file;
    if (!inside || !inScope(shown, scopes, platform)) out.push(shown);
  }
  return out;
}
