import { GraftError } from '@shared/errors';
import type { ModelRoleId } from '@shared/schemas/agentRuns';
import type { ModelRef } from '@shared/schemas/common';
import type { ModelInfo } from '@shared/schemas/models';
import { maskSecrets } from '@shared/secrets';
import { runGit } from '../git/git';
import { currentBranch, defaultBranch, headCommit } from '../git/repo';
import { findCommand } from '../mcp/integrations';
import type { LLMProvider } from '../providers/types';
import { runFile, type RunResult } from '../tools/run';
import { routeModel } from './modelRouter';
import type { ModelResolver } from './session';

/**
 * /review and /security-review: what is reviewed (the uncommitted changes, the
 * branch, one commit or a pull request), worked out before any model is asked,
 * so a scope that can't be reviewed says why at once. The turn that follows is
 * read-only and reports what it found with ReportFindings.
 */

export type ReviewKind = 'review' | 'security';

/** Where a review looks, as typed after the command. */
export type ReviewTarget = { kind: 'uncommitted' } | { kind: 'branch' } | { kind: 'commit'; rev: string } | { kind: 'pr'; number: number | null };

/** Where a review looks, once git (and gh) said what is there. */
export type ReviewScope =
  | { kind: 'uncommitted' }
  | { kind: 'branch'; branch: string; base: string; mergeBase: string }
  | { kind: 'commit'; sha: string; subject: string }
  | { kind: 'pr'; number: number; diff: string; cut: boolean };

/** Runs the GitHub CLI with these arguments. */
export type GhRunner = (args: string[]) => Promise<RunResult>;

/** A pull request's diff travels in the message, cut at this many characters. */
export const PR_DIFF_LIMIT = 60_000;

/** What an action that would change something is refused with while a review runs. */
export const REVIEW_READ_ONLY = 'This review is read-only, so nothing can be changed while it runs. Report what should change with ReportFindings instead.';

const SHA = /^[0-9a-f]{7,40}$/i;

/**
 * `branch`, `pr <number>` or a commit's hash first; what follows (or the whole
 * text, for the uncommitted changes) is what to focus on. A word of hex letters
 * with no digit ("added", "deface") is read as a word, not as a hash.
 */
export function parseReviewArgs(args: string): { target: ReviewTarget; focus: string } {
  const words = args.trim().split(/\s+/).filter((word) => word.length > 0);
  const first = words[0]?.toLowerCase() ?? '';
  if (first === 'branch') return { target: { kind: 'branch' }, focus: words.slice(1).join(' ') };
  if (first === 'pr') {
    const number = /^#?(\d{1,9})$/.exec(words[1] ?? '');
    return { target: { kind: 'pr', number: number ? Number(number[1]) : null }, focus: words.slice(number ? 2 : 1).join(' ') };
  }
  if (SHA.test(first) && /\d/.test(first)) return { target: { kind: 'commit', rev: first }, focus: words.slice(1).join(' ') };
  return { target: { kind: 'uncommitted' }, focus: args.trim() };
}

async function dirty(dir: string): Promise<boolean> {
  const status = await runGit(['status', '--porcelain', '--untracked-files=all'], { cwd: dir, allowFail: true });
  return status.stdout.trim().length > 0;
}

/**
 * The branch's work, measured as the Changes card measures it (see diffStats): from where it left the default
 * branch. A branch with no commits of its own, the default branch itself, or one whose base can't be found has
 * done only what is uncommitted, so that is what is reviewed.
 */
async function branchScope(dir: string): Promise<ReviewScope> {
  const branch = await currentBranch(dir);
  if (!branch) throw new GraftError('review_detached', 'HEAD is detached, so there is no branch to compare. Check out a branch, or review one commit with /review <commit>.');
  const head = await headCommit(dir);
  const base = await defaultBranch(dir);
  if (head && base && base !== branch) {
    const found = await runGit(['merge-base', 'HEAD', base], { cwd: dir, allowFail: true });
    const mergeBase = found.code === 0 ? found.stdout.trim() : '';
    if (mergeBase && mergeBase !== head) return { kind: 'branch', branch, base, mergeBase };
  }
  if (!(await dirty(dir))) {
    throw new GraftError(
      'nothing_to_review',
      base && base !== branch ? `${branch} has no commits or changes since it left ${base}, so there is nothing to review.` : `${branch} has no uncommitted changes, so there is nothing to review. To review a commit, use /review <commit>.`
    );
  }
  return { kind: 'uncommitted' };
}

async function commitScope(dir: string, rev: string): Promise<ReviewScope> {
  const found = await runGit(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { cwd: dir, allowFail: true });
  const sha = found.stdout.trim();
  if (found.code !== 0 || sha.length === 0) throw new GraftError('review_no_commit', `There is no commit ${rev} in this repository. Check the hash with git log.`);
  const subject = await runGit(['log', '-1', '--format=%s', sha], { cwd: dir, allowFail: true });
  return { kind: 'commit', sha, subject: maskSecrets(subject.stdout.trim()) };
}

async function prScope(number: number | null, gh: GhRunner | null): Promise<ReviewScope> {
  if (number === null) throw new GraftError('review_pr_number', 'Say which pull request to review by its number, for example /review pr 12.');
  if (!gh) {
    throw new GraftError('gh_missing', 'Reviewing a pull request needs the GitHub CLI (gh), which is not installed. Install it from cli.github.com, sign in with gh auth login, then try again.');
  }
  const auth = await gh(['auth', 'status']);
  if (auth.code !== 0) throw new GraftError('gh_signed_out', `The GitHub CLI is not signed in. Run gh auth login in a terminal, then try /review pr ${String(number)} again.`);
  const diff = await gh(['pr', 'diff', String(number), '--color', 'never']);
  if (diff.code !== 0) {
    const why = ((diff.stderr.trim() || diff.stdout.trim()).split('\n')[0] ?? '').replace(/\.$/, '');
    throw new GraftError('gh_pr_failed', `gh couldn't get pull request #${String(number)}${why ? `: ${why}` : ''}.`);
  }
  if (diff.stdout.trim().length === 0) throw new GraftError('nothing_to_review', `Pull request #${String(number)} changes nothing, so there is nothing to review.`);
  // The diff goes to the model: keys and passwords in it are covered first.
  const masked = maskSecrets(diff.stdout);
  return { kind: 'pr', number, diff: masked.slice(0, PR_DIFF_LIMIT), cut: masked.length > PR_DIFF_LIMIT };
}

/** What `target` holds in the repository at `dir`. Throws a GraftError whose message says what to do when there is nothing to review. */
export async function resolveReviewScope(dir: string, target: ReviewTarget, gh: GhRunner | null): Promise<ReviewScope> {
  const top = await runGit(['rev-parse', '--show-toplevel'], { cwd: dir, allowFail: true });
  if (top.code !== 0) {
    throw new GraftError('review_not_git', "A review compares changes with git, and this folder isn't a git repository. Ask for a review of a file or a feature in a message instead.");
  }
  switch (target.kind) {
    case 'uncommitted':
      if (!(await dirty(dir))) throw new GraftError('nothing_to_review', 'There are no uncommitted changes to review. For work that is committed, use /review branch or /review <commit>.');
      return { kind: 'uncommitted' };
    case 'branch':
      return branchScope(dir);
    case 'commit':
      return commitScope(dir, target.rev);
    case 'pr':
      return prScope(target.number, gh);
  }
}

/** The GitHub CLI, run in `dir`, where it is installed; null where it isn't. */
export function ghCli(dir: string): GhRunner | null {
  const gh = findCommand('gh', process.platform, process.env);
  return gh ? (args) => runFile(gh, args, { cwd: dir, timeoutMs: 60_000 }) : null;
}

function subjectOf(scope: ReviewScope): string {
  switch (scope.kind) {
    case 'uncommitted':
      return 'the uncommitted changes in this repository';
    case 'branch':
      return `the work on the branch ${scope.branch} since it left ${scope.base}`;
    case 'commit':
      return `commit ${scope.sha.slice(0, 12)}${scope.subject ? ` ("${scope.subject}")` : ''}`;
    case 'pr':
      return `pull request #${String(scope.number)}`;
  }
}

function howToSee(scope: ReviewScope): string {
  switch (scope.kind) {
    case 'uncommitted':
      return 'Run git status, git diff and git diff --staged to see them, and read the new files git status lists as untracked.';
    case 'branch':
      return `Run git diff ${scope.mergeBase} to see every change since then, committed or not, and git log --oneline ${scope.mergeBase}..HEAD for its commits; read the new files git status lists as untracked too.`;
    case 'commit':
      return `Run git show ${scope.sha} to see it.`;
    case 'pr':
      return `Its diff, from gh pr diff ${String(scope.number)}, is below. This folder may hold another version of the code than the pull request: read the files here for context, and judge the change by the diff.`;
  }
}

/** The message a review sends: what to look at, what to look for, that it changes nothing, and how to report. */
export function reviewMessage(kind: ReviewKind, scope: ReviewScope, focus: string): string {
  const look =
    kind === 'security'
      ? 'Look for security problems: injection (SQL, shell, path, template), broken authentication or authorization, secrets in code or logs, unsafe deserialization, SSRF, XSS, insecure defaults, missing input validation at trust boundaries and risky dependencies. In each finding, say how it could be exploited.'
      : 'Look for bugs, missed edge cases, race conditions, broken error handling, lost data, security problems and missing tests.';
  const text = [
    `${kind === 'security' ? 'Do a security review of' : 'Review'} ${subjectOf(scope)}. ${howToSee(scope)}`,
    'Read the code around each change as well, not only the diff: what it calls, what calls it, and its tests.',
    look,
    "This review is read-only: don't edit files and don't run commands that change anything.",
    'Then call ReportFindings once with every finding: the file (relative to the project folder) and line, the severity (high: it breaks something, loses data or opens a hole; medium: a real bug in a less common case; low: minor), a short title, the concrete failure as the detail (what input or state leads to what wrong result) and a suggested fix. Report only real, specific problems: no style preferences and no praise. If you find nothing, call it with an empty list. Finish with two or three sentences on what you checked and what you could not.',
    ...(focus.length > 0 ? [`Focus especially on: ${focus}`] : [])
  ].join('\n\n');
  if (scope.kind !== 'pr') return text;
  const cut = scope.cut ? `\n\nThe diff was cut at ${PR_DIFF_LIMIT.toLocaleString('en-US')} characters: say which files you could not see.` : '';
  return `${text}\n\n\`\`\`diff\n${scope.diff.trimEnd()}\n\`\`\`${cut}`;
}

/** The role a review's model comes from: a security review's own when Settings → Models sets one, otherwise the reviewer's; null when neither is set. */
export function reviewRole(kind: ReviewKind, roles: Partial<Record<ModelRoleId, ModelRef | null>>): ModelRoleId | null {
  if (kind === 'security' && roles.security) return 'security';
  return roles.reviewer ? 'reviewer' : null;
}

interface Answerer {
  provider: LLMProvider;
  model: ModelInfo;
  ref: ModelRef;
}

/**
 * The model a review runs on: the one assigned to its role, when it is there and can use tools; otherwise
 * the session's (routeModel says why). An incognito session keeps its own, which its privacy rules chose.
 */
export async function reviewModel(
  kind: ReviewKind,
  session: Answerer,
  options: { roles: Partial<Record<ModelRoleId, ModelRef | null>>; incognito: boolean; models: ModelResolver },
  signal: AbortSignal
): Promise<Answerer> {
  const role = reviewRole(kind, options.roles);
  if (role === null || options.incognito) return session;
  const candidates = (await options.models.candidates?.(signal).catch(() => null)) ?? [session.model];
  const route = routeModel({ modelRole: role, needsVision: false, session: session.model, candidates, routing: 'session', assignments: options.roles });
  if (route.ref.providerId === session.ref.providerId && route.ref.modelId === session.ref.modelId) return session;
  return { ...(await options.models.resolve(route.ref, signal)), ref: route.ref };
}
