import fs from 'node:fs';
import path from 'node:path';
import { GraftError } from '@shared/errors';
import { git, runGit } from './git';
import { repoRoot } from './repo';

export interface WorktreeInfo {
  path: string;
  branch: string;
  repoRoot: string;
}

export interface WorktreeState {
  dirty: boolean;
  changedFiles: number;
  untrackedFiles: number;
}

/** Lower-case, dash-separated, filesystem- and ref-safe slug. */
export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, max)
    .replace(/-$/, '');
  return slug.length > 0 ? slug : 'session';
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await runGit(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { cwd: repo, allowFail: true })).code === 0;
}

/**
 * Creates a worktree for a session at <root>/<repo>/<slug> on a new branch
 * graft/<slug>, adding a numeric suffix when either is taken.
 */
export async function createWorktree(options: { repoDir: string; worktreesRoot: string; slug: string; baseRef?: string }): Promise<WorktreeInfo> {
  const root = await repoRoot(options.repoDir);
  const hasHead = (await runGit(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root, allowFail: true })).code === 0;
  if (!hasHead) throw new GraftError('worktree_no_commits', 'Worktrees need at least one commit. Make an initial commit first.');
  const repoName = slugify(path.basename(root), 60);
  const base = slugify(options.slug);
  for (let n = 1; n < 100; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const dir = path.join(options.worktreesRoot, repoName, slug);
    const branch = `graft/${slug}`;
    if (fs.existsSync(dir) || (await branchExists(root, branch))) continue;
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(['worktree', 'add', '-b', branch, dir, options.baseRef ?? 'HEAD'], { cwd: root });
    return { path: dir, branch, repoRoot: root };
  }
  throw new GraftError('worktree_exists', `Couldn't find a free worktree name for "${base}".`);
}

export async function worktreeState(worktreePath: string): Promise<WorktreeState> {
  const out = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: worktreePath });
  const entries = out.split('\0').filter((e) => e.length > 0 && /^[ MADRCU?!]{2} /.test(e));
  const untracked = entries.filter((e) => e.startsWith('??')).length;
  return { dirty: entries.length > 0, changedFiles: entries.length - untracked, untrackedFiles: untracked };
}

/**
 * Removes a session worktree. Refuses when it has uncommitted or untracked
 * work unless `force` (the UI asks first). The branch is deleted only when
 * git considers it merged; otherwise it is kept and reported.
 */
export async function removeWorktree(options: {
  repoDir: string;
  worktreePath: string;
  branch: string | null;
  force: boolean;
  deleteBranch: boolean;
}): Promise<{ branchDeleted: boolean; branchKeptReason: string | null }> {
  if (fs.existsSync(options.worktreePath)) {
    if (!options.force) {
      const state = await worktreeState(options.worktreePath);
      if (state.dirty) {
        throw new GraftError(
          'worktree_dirty',
          `The worktree has ${state.changedFiles} changed and ${state.untrackedFiles} untracked files. Commit them, or confirm to discard them.`,
          { details: { changed: state.changedFiles, untracked: state.untrackedFiles } }
        );
      }
    }
    await git(['worktree', 'remove', ...(options.force ? ['--force'] : []), options.worktreePath], { cwd: options.repoDir });
  }
  await git(['worktree', 'prune'], { cwd: options.repoDir });
  if (!options.deleteBranch || !options.branch) return { branchDeleted: false, branchKeptReason: null };
  const deleted = await runGit(['branch', '-d', options.branch], { cwd: options.repoDir, allowFail: true });
  if (deleted.code === 0) return { branchDeleted: true, branchKeptReason: null };
  return { branchDeleted: false, branchKeptReason: deleted.stderr.trim() || 'The branch has unmerged commits.' };
}
