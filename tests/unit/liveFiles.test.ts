import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveFiles, type WatchFile } from '../../src/main/files/liveFiles';
import { makeTempDir, removeDir } from '../support/tmp';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

let root: string;
/** The watches the tested class holds open, by file: calling one says the file may have changed. */
let pokes: Map<string, () => void>;
let changes: Array<[string, string]>;
let live: LiveFiles;
const watchFile: WatchFile = (file, changed) => {
  pokes.set(file, changed);
  return () => pokes.delete(file);
};
const poke = (name: string): void => pokes.get(path.resolve(root, name))?.();

beforeEach(() => {
  vi.useFakeTimers();
  root = makeTempDir();
  pokes = new Map();
  changes = [];
  live = new LiveFiles((sessionId, file) => changes.push([sessionId, file]), watchFile, 150);
  fs.writeFileSync(path.join(root, 'notes.txt'), 'first');
});
afterEach(() => {
  live.dispose();
  vi.useRealTimers();
  removeDir(root);
});

describe('watching the files the editor shows', () => {
  it('reports a burst of writes once, after it settles, and only when the bytes changed', () => {
    live.watch('s1', root, [{ path: 'notes.txt', revision: sha('first') }]);
    vi.advanceTimersByTime(200);
    expect(changes).toEqual([]);
    for (const text of ['sec', 'second']) {
      fs.writeFileSync(path.join(root, 'notes.txt'), text);
      poke('notes.txt');
      vi.advanceTimersByTime(100);
    }
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(changes).toEqual([['s1', 'notes.txt']]);
    // Touched without a change in its bytes: nothing to tell.
    poke('notes.txt');
    vi.advanceTimersByTime(200);
    expect(changes).toHaveLength(1);
  });

  it('does not report the editor’s own save, and reports a change made before the watch began', () => {
    live.watch('s1', root, [{ path: 'notes.txt', revision: sha('stale') }]);
    vi.advanceTimersByTime(200);
    expect(changes).toEqual([['s1', 'notes.txt']]);
    fs.writeFileSync(path.join(root, 'notes.txt'), 'saved by the editor');
    live.saved('s1', 'notes.txt', sha('saved by the editor'));
    poke('notes.txt');
    vi.advanceTimersByTime(200);
    expect(changes).toHaveLength(1);
    fs.rmSync(path.join(root, 'notes.txt'));
    poke('notes.txt');
    vi.advanceTimersByTime(200);
    expect(changes).toEqual([['s1', 'notes.txt'], ['s1', 'notes.txt']]);
  });

  it('stops watching a file left out, a released session, and refuses a path outside the folder', () => {
    fs.writeFileSync(path.join(root, 'other.txt'), 'other');
    live.watch('s1', root, [{ path: 'notes.txt', revision: sha('first') }, { path: 'other.txt', revision: sha('other') }]);
    expect(pokes.size).toBe(2);
    live.watch('s1', root, [{ path: 'other.txt', revision: sha('other') }]);
    expect([...pokes.keys()]).toEqual([path.resolve(root, 'other.txt')]);
    // A check already waiting when the watch stops tells nothing.
    fs.writeFileSync(path.join(root, 'other.txt'), 'changed');
    poke('other.txt');
    live.release('s1');
    vi.advanceTimersByTime(200);
    expect(pokes.size).toBe(0);
    expect(changes).toEqual([]);
    expect(() => live.watch('s1', root, [{ path: '../outside.txt', revision: sha('x') }])).toThrow(/outside the session folder/);
    expect(pokes.size).toBe(0);
  });

  it('follows a session that moved to another folder', () => {
    const worktree = makeTempDir();
    try {
      fs.writeFileSync(path.join(worktree, 'notes.txt'), 'first');
      live.watch('s1', root, [{ path: 'notes.txt', revision: sha('first') }]);
      live.watch('s1', worktree, [{ path: 'notes.txt', revision: sha('first') }]);
      expect([...pokes.keys()]).toEqual([path.resolve(worktree, 'notes.txt')]);
      fs.writeFileSync(path.join(worktree, 'notes.txt'), 'changed in the worktree');
      pokes.get(path.resolve(worktree, 'notes.txt'))?.();
      vi.advanceTimersByTime(200);
      expect(changes).toEqual([['s1', 'notes.txt']]);
    } finally {
      live.release('s1');
      removeDir(worktree);
    }
  });
});
