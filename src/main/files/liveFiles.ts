import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GraftError } from '@shared/errors';
import { isInsideReal } from '../tools/paths';

/** Calls `changed` whenever a file may have changed; the function it returns stops that. */
export type WatchFile = (file: string, changed: () => void) => () => void;

/**
 * Polls the file's stat a few times a second. No handle is held open, so Windows can still delete or rename the
 * file and its folder, and a file replaced by a rename (an atomic save) is seen the same way on every system.
 */
const pollFile: WatchFile = (file, changed) => {
  const listener = (): void => changed();
  fs.watchFile(file, { interval: 300, persistent: false }, listener);
  return () => fs.unwatchFile(file, listener);
};

interface Watched {
  path: string;
  file: string;
  /** The bytes the editor has (sha256); null while the file is not there. */
  revision: string | null;
  timer?: ReturnType<typeof setTimeout>;
  stop: () => void;
}

/** A file's revision as the editor names it, or null when it cannot be read. One grown past the editor's size is told by its stat. */
function revisionOf(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (stat.size > 4 * 1024 * 1024) return `${String(stat.size)}:${String(stat.mtimeMs)}`;
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * The files each session's editor shows, watched for changes made on disk (an agent's edit, a formatter, git).
 * A change is reported once it has settled for `settleMs`, and only when the bytes differ from the revision the
 * editor has; its own saves (see `saved`) are not reported back to it.
 */
export class LiveFiles {
  private readonly sessions = new Map<string, Map<string, Watched>>();

  constructor(
    private readonly changed: (sessionId: string, path: string) => void,
    private readonly watchFile: WatchFile = pollFile,
    private readonly settleMs = 150
  ) {}

  /** Watches exactly these files of a session's folder, from the revisions the editor has; files left out are no longer watched. */
  watch(sessionId: string, root: string, files: ReadonlyArray<{ path: string; revision: string }>): void {
    for (const { path: rel } of files) {
      if (!isInsideReal(root, path.resolve(root, rel))) throw new GraftError('outside_folder', 'That path is outside the session folder.');
    }
    const watched = this.sessions.get(sessionId) ?? new Map<string, Watched>();
    for (const [rel, entry] of watched) {
      if (files.some((f) => f.path === rel)) continue;
      this.stop(entry);
      watched.delete(rel);
    }
    for (const { path: rel, revision } of files) {
      let entry = watched.get(rel);
      if (entry) entry.revision = revision;
      else {
        const added: Watched = { path: rel, file: path.resolve(root, rel), revision, stop: () => undefined };
        added.stop = this.watchFile(added.file, () => this.settle(sessionId, added));
        watched.set(rel, (entry = added));
      }
      // A change made between the editor's read and this call is reported now.
      this.settle(sessionId, entry);
    }
    if (watched.size) this.sessions.set(sessionId, watched);
    else this.sessions.delete(sessionId);
  }

  /** The editor saved this revision of a file itself. */
  saved(sessionId: string, rel: string, revision: string): void {
    const entry = this.sessions.get(sessionId)?.get(rel);
    if (entry) entry.revision = revision;
  }

  /** Stops watching a session's files (its tab or the session closed). */
  release(sessionId: string): void {
    for (const entry of this.sessions.get(sessionId)?.values() ?? []) this.stop(entry);
    this.sessions.delete(sessionId);
  }

  dispose(): void {
    for (const sessionId of [...this.sessions.keys()]) this.release(sessionId);
  }

  private stop(entry: Watched): void {
    clearTimeout(entry.timer);
    entry.stop();
  }

  private settle(sessionId: string, entry: Watched): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (this.sessions.get(sessionId)?.get(entry.path) !== entry) return;
      const revision = revisionOf(entry.file);
      if (revision === entry.revision) return;
      entry.revision = revision;
      this.changed(sessionId, entry.path);
    }, this.settleMs);
  }
}
