import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { GraftError } from '@shared/errors';
import { fromGitPath, git, runGit } from './git';
import { currentBranch } from './repo';

export type StagedStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'T';
export type UnstagedStatus = 'M' | 'D' | 'T';

export interface ChangedFile {
  path: string;
  origPath: string | null;
  staged: StagedStatus | null;
  unstaged: UnstagedStatus | null;
  untracked: boolean;
  conflicted: boolean;
}

export interface Hunk {
  header: string;
  lines: string[];
  oldStart: number;
  newStart: number;
}

export interface FileDiff {
  path: string;
  staged: boolean;
  binary: boolean;
  /** File header lines (diff --git …, ---, +++) shared by every hunk. */
  header: string;
  hunks: Hunk[];
  added: number;
  removed: number;
}

function code<T extends string>(c: string | undefined, allowed: readonly T[]): T | null {
  return c !== undefined && (allowed as readonly string[]).includes(c) ? (c as T) : null;
}

/** Parses `git status --porcelain=v2 -z`. */
export function parseStatus(out: string): ChangedFile[] {
  const parts = out.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length === 0) continue;
    const kind = entry[0];
    if (kind === '?') {
      files.push({ path: entry.slice(2), origPath: null, staged: null, unstaged: null, untracked: true, conflicted: false });
    } else if (kind === '1' || kind === '2' || kind === 'u') {
      const fields = entry.split(' ');
      const xy = fields[1] ?? '..';
      const pathFields = kind === '1' ? 8 : kind === '2' ? 9 : 10;
      const file = fields.slice(pathFields).join(' ');
      const origPath = kind === '2' ? (parts[++i] ?? null) : null;
      files.push({
        path: file,
        origPath,
        staged: code(xy[0], ['M', 'A', 'D', 'R', 'C', 'T'] as const),
        unstaged: code(xy[1], ['M', 'D', 'T'] as const),
        untracked: false,
        conflicted: kind === 'u'
      });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * git prints porcelain paths relative to the repository root, never the cwd
 * (status.relativePaths does not apply to porcelain). Callers work in the
 * session's folder, which is not always the repo root, so rebase the paths
 * onto it: otherwise `path.join(workDir, file)` and `git add -- <file>`
 * address the wrong file, and reverting one would discard another.
 */
async function relativeTo(workDir: string, files: ChangedFile[]): Promise<ChangedFile[]> {
  const top = await runGit(['rev-parse', '--show-toplevel'], { cwd: workDir, allowFail: true });
  if (top.code !== 0) return files;
  const root = fromGitPath(top.stdout);
  if (path.resolve(root) === path.resolve(workDir)) return files;
  const rebase = (p: string): string => path.relative(workDir, path.join(root, p)).split(path.sep).join('/');
  return files.map((f) => ({ ...f, path: rebase(f.path), origPath: f.origPath === null ? null : rebase(f.origPath) }));
}

export async function listChanges(workDir: string): Promise<ChangedFile[]> {
  const out = await git(['status', '--porcelain=v2', '-z', '--untracked-files=all'], { cwd: workDir });
  return relativeTo(workDir, parseStatus(out));
}

/** Splits a unified diff for one file into its header and hunks. */
export function parseDiff(patch: string): { header: string; hunks: Hunk[]; binary: boolean } {
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const headerLines: string[] = [];
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (match) {
      current = { header: line, lines: [], oldStart: Number(match[1]), newStart: Number(match[2]) };
      hunks.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      headerLines.push(line);
    }
  }
  const binary = headerLines.some((l) => l.startsWith('Binary files') || l.startsWith('GIT binary patch'));
  return { header: headerLines.join('\n'), hunks, binary };
}

function counts(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
    }
  }
  return { added, removed };
}

export async function fileDiff(workDir: string, file: string, staged: boolean): Promise<FileDiff> {
  const status = (await listChanges(workDir)).find((f) => f.path === file);
  if (status?.untracked && !staged) {
    const abs = path.join(workDir, file);
    const buffer = fs.readFileSync(abs);
    if (buffer.subarray(0, 8000).includes(0)) {
      return { path: file, staged, binary: true, header: `diff --git a/${file} b/${file}\nnew file`, hunks: [], added: 0, removed: 0 };
    }
    const patch = createTwoFilesPatch('/dev/null', `b/${file}`, '', buffer.toString('utf8').replace(/\r\n/g, '\n'), '', '', { context: 3 });
    const parsed = parseDiff(patch.replace(/^Index:.*\n=+\n/, ''));
    return { path: file, staged, binary: false, header: `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}`, hunks: parsed.hunks, ...counts(parsed.hunks) };
  }
  const out = await git(['diff', ...(staged ? ['--cached'] : []), '--no-color', '--no-ext-diff', '-U3', '--', file], { cwd: workDir });
  const parsed = parseDiff(out);
  return { path: file, staged, binary: parsed.binary, header: parsed.header, hunks: parsed.hunks, ...counts(parsed.hunks) };
}

export function hunkPatch(diff: FileDiff, index: number): string {
  const hunk = diff.hunks[index];
  if (!hunk) throw new GraftError('hunk_not_found', 'That change is no longer in the diff. Refresh and try again.');
  return `${diff.header}\n${hunk.header}\n${hunk.lines.join('\n')}\n`;
}

export async function stageFiles(workDir: string, files: string[]): Promise<void> {
  if (files.length > 0) await git(['add', '-A', '--', ...files], { cwd: workDir });
}

export async function unstageFiles(workDir: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  const hasHead = (await runGit(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: workDir, allowFail: true })).code === 0;
  if (hasHead) await git(['restore', '--staged', '--', ...files], { cwd: workDir });
  else await git(['rm', '--cached', '-r', '-q', '--', ...files], { cwd: workDir });
}

/**
 * Discards working-tree changes for files (the index is kept). Untracked
 * files are deleted. Destructive: callers must have the user's confirmation.
 */
export async function revertFiles(workDir: string, files: string[]): Promise<void> {
  const status = await listChanges(workDir);
  const untracked = files.filter((f) => status.find((s) => s.path === f)?.untracked);
  const tracked = files.filter((f) => !untracked.includes(f));
  if (tracked.length > 0) await git(['restore', '--worktree', '--', ...tracked], { cwd: workDir });
  for (const f of untracked) fs.rmSync(path.join(workDir, f), { force: true });
}

export async function stageHunk(workDir: string, file: string, index: number): Promise<void> {
  const diff = await fileDiff(workDir, file, false);
  if ((await listChanges(workDir)).find((f) => f.path === file)?.untracked) {
    throw new GraftError('hunk_untracked', 'Stage a new file as a whole.');
  }
  await git(['apply', '--cached', '--whitespace=nowarn', '-'], { cwd: workDir, input: hunkPatch(diff, index) });
}

export async function unstageHunk(workDir: string, file: string, index: number): Promise<void> {
  const diff = await fileDiff(workDir, file, true);
  await git(['apply', '--cached', '-R', '--whitespace=nowarn', '-'], { cwd: workDir, input: hunkPatch(diff, index) });
}

/** Discards one unstaged hunk from the working tree. Destructive: confirm first. */
export async function revertHunk(workDir: string, file: string, index: number): Promise<void> {
  const diff = await fileDiff(workDir, file, false);
  await git(['apply', '-R', '--whitespace=nowarn', '-'], { cwd: workDir, input: hunkPatch(diff, index) });
}

export async function hasStagedChanges(workDir: string): Promise<boolean> {
  return (await runGit(['diff', '--cached', '--quiet'], { cwd: workDir, allowFail: true })).code === 1;
}

/** Commits staged changes (or everything, with stageAll). Runs the user's git hooks. */
export async function commit(workDir: string, message: string, options: { stageAll: boolean }): Promise<string> {
  const trimmed = message.trim();
  if (trimmed.length === 0) throw new GraftError('empty_commit_message', 'Write a commit message first.');
  if (options.stageAll) await git(['add', '-A'], { cwd: workDir });
  if (!(await hasStagedChanges(workDir))) throw new GraftError('nothing_to_commit', 'There are no changes to commit.');
  await git(['commit', '-q', '-F', '-'], { cwd: workDir, input: trimmed });
  return (await git(['rev-parse', 'HEAD'], { cwd: workDir })).trim();
}

/** Pushes the current branch, setting the upstream the first time. */
export async function push(workDir: string): Promise<{ branch: string }> {
  const branch = await currentBranch(workDir);
  if (!branch) throw new GraftError('detached_head', 'Check out a branch before pushing.');
  const upstream = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: workDir, allowFail: true });
  const result = await runGit(upstream.code === 0 ? ['push'] : ['push', '-u', 'origin', branch], { cwd: workDir, allowFail: true, timeoutMs: 180_000 });
  if (result.code !== 0) {
    const detail = result.stderr.trim().split('\n').slice(-4).join(' ');
    const auth = /authentication|permission denied|could not read username|403|401/i.test(detail);
    throw new GraftError(auth ? 'push_auth' : 'push_failed', auth ? `Git couldn't authenticate to push: ${detail}` : `Push failed: ${detail}`);
  }
  return { branch };
}

/** Diff text used to suggest a commit message (staged, else everything). */
export async function diffForMessage(workDir: string, maxChars = 24_000): Promise<string> {
  const staged = await hasStagedChanges(workDir);
  const out = await git(['diff', ...(staged ? ['--cached'] : ['HEAD']), '--no-color', '--stat', '--patch', '-U2'], { cwd: workDir });
  return out.length > maxChars ? `${out.slice(0, maxChars)}\n… [diff truncated]` : out;
}
