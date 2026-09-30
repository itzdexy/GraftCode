import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './git';
import { currentBranch, defaultBranch, headCommit } from './repo';

export interface DiffStats {
  added: number;
  removed: number;
  files: number;
  /** Commit the stats are measured from (merge-base with the default branch, or HEAD). */
  base: string | null;
  branch: string | null;
}

const EMPTY: DiffStats = { added: 0, removed: 0, files: 0, base: null, branch: null };
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

function countLines(file: string): number {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_UNTRACKED_BYTES) return 0;
    const buffer = fs.readFileSync(file);
    if (buffer.subarray(0, 8000).includes(0)) return 0;
    if (buffer.length === 0) return 0;
    let lines = 0;
    for (const byte of buffer) if (byte === 10) lines++;
    return buffer[buffer.length - 1] === 10 ? lines : lines + 1;
  } catch {
    return 0;
  }
}

/**
 * Lines added/removed by this branch's work: against the merge-base with the
 * default branch when on a feature branch, otherwise against HEAD. Includes
 * staged, unstaged and untracked (non-ignored) changes.
 */
export async function computeDiffStats(workDir: string): Promise<DiffStats> {
  const top = await runGit(['rev-parse', '--show-toplevel'], { cwd: workDir, allowFail: true });
  if (top.code !== 0) return EMPTY;
  const root = path.normalize(top.stdout.trim());
  const head = await headCommit(root);
  const branch = await currentBranch(root);
  let base = head;
  if (head && branch) {
    const main = await defaultBranch(root);
    if (main && main !== branch) {
      const mergeBase = await runGit(['merge-base', 'HEAD', main], { cwd: root, allowFail: true });
      if (mergeBase.code === 0 && mergeBase.stdout.trim()) base = mergeBase.stdout.trim();
    }
  }
  let added = 0;
  let removed = 0;
  let files = 0;
  if (base) {
    const numstat = await runGit(['diff', '--numstat', '-z', '--no-renames', base, '--'], { cwd: root, allowFail: true });
    for (const entry of numstat.stdout.split('\0')) {
      const match = /^(\d+|-)\t(\d+|-)\t/.exec(entry);
      if (!match) continue;
      files++;
      if (match[1] !== '-') added += Number(match[1]);
      if (match[2] !== '-') removed += Number(match[2]);
    }
  }
  const untracked = await runGit(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, allowFail: true });
  for (const rel of untracked.stdout.split('\0').filter((p) => p.length > 0)) {
    files++;
    added += countLines(path.join(root, rel));
  }
  return { added, removed, files, base, branch };
}

/**
 * Cheap repeated reads: results are cached briefly and concurrent requests
 * for the same folder share one computation.
 */
export class DiffStatsCache {
  private readonly cache = new Map<string, { at: number; value: DiffStats }>();
  private readonly inflight = new Map<string, Promise<DiffStats>>();

  constructor(private readonly ttlMs = 1500) {}

  get(workDir: string): Promise<DiffStats> {
    const key = path.resolve(workDir);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return Promise.resolve(hit.value);
    const running = this.inflight.get(key);
    if (running) return running;
    const promise = computeDiffStats(key)
      .then((value) => {
        this.cache.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  invalidate(workDir: string): void {
    this.cache.delete(path.resolve(workDir));
  }
}
