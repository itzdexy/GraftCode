import fs from 'node:fs';
import path from 'node:path';
import { GraftError } from '@shared/errors';

/**
 * Folder creation that can't hang. Node's recursive mkdir retries a folder
 * forever when Windows answers "not found" although its parent exists, which
 * is how Controlled folder access refuses an app; run synchronously, that froze
 * the whole app. These create one level at a time, try each once, and explain
 * a refusal.
 */

type Kind = 'dir' | 'file' | 'none';

function kindSync(at: string): Kind {
  try {
    return fs.statSync(at).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'none';
  }
}

async function kind(at: string): Promise<Kind> {
  try {
    return (await fs.promises.stat(at)).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'none';
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/**
 * A clear error for a change Windows refused, where Node would only say "not
 * found" or "operation not permitted". Anything else passes through unchanged.
 */
export function refusedChange(target: string, error: unknown, verb: 'create' | 'write'): Error {
  const code = errorCode(error);
  if (process.platform === 'win32' && (code === 'ENOENT' || code === 'EPERM' || code === 'EACCES')) {
    return new GraftError(
      'folder_protected',
      `Windows didn't let Graft ${verb} ${target}. If Controlled folder access is on, allow Graft in Windows Security › Virus & threat protection › Ransomware protection › Allow an app through Controlled folder access, or use a folder outside Documents, Desktop, Pictures, Videos and Music.`,
      { cause: error, details: { code: code ?? null } }
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function refusedFolder(level: string, error: unknown): Error {
  if (errorCode(error) === 'EEXIST') return new GraftError('not_a_folder', `Couldn't create the folder ${level}: a file with that name is in the way.`, { cause: error });
  return refusedChange(level, error, 'create');
}

/** The folders to create for dir, outermost first: everything below its deepest existing ancestor. */
function missingSync(dir: string): string[] {
  const missing: string[] = [];
  for (let at = path.resolve(dir); kindSync(at) !== 'dir'; at = path.dirname(at)) {
    missing.unshift(at);
    if (path.dirname(at) === at) break;
  }
  return missing;
}

async function missing(dir: string): Promise<string[]> {
  const levels: string[] = [];
  for (let at = path.resolve(dir); (await kind(at)) !== 'dir'; at = path.dirname(at)) {
    levels.unshift(at);
    if (path.dirname(at) === at) break;
  }
  return levels;
}

/** Creates dir and any missing parents. A folder that already exists is fine. */
export function makeDirSync(dir: string): void {
  for (const level of missingSync(dir)) {
    try {
      fs.mkdirSync(level);
    } catch (error) {
      // Made by someone else in the meantime: fine, unless it's a file.
      if (errorCode(error) !== 'EEXIST' || kindSync(level) === 'file') throw refusedFolder(level, error);
    }
  }
}

/** Creates dir and any missing parents. A folder that already exists is fine. */
export async function makeDir(dir: string): Promise<void> {
  for (const level of await missing(dir)) {
    try {
      await fs.promises.mkdir(level);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST' || (await kind(level)) === 'file') throw refusedFolder(level, error);
    }
  }
}
