import { afterEach, describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/main/tools/run';
import { parseReviewArgs, PR_DIFF_LIMIT, resolveReviewScope, reviewMessage, reviewRole, type GhRunner } from '../../src/main/agent/reviewScope';
import { gitSync, makeRepo } from '../support/gitRepo';
import { makeTempDir, removeDir, writeFile } from '../support/tmp';

const cleanup: string[] = [];
const track = (dir: string): string => {
  cleanup.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of cleanup.splice(0)) removeDir(dir);
});

/** A GitHub CLI that answers from a table: `auth status` and `pr diff` by their first two words. */
function fakeGh(answers: Record<string, RunResult>): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (args: string[]): Promise<RunResult> => {
    calls.push(args);
    return Promise.resolve(answers[args.slice(0, 2).join(' ')] ?? { code: 1, stdout: '', stderr: 'unknown command' });
  };
  return Object.assign(run, { calls });
}

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });

describe('what follows /review', () => {
  it('reads the branch, a pull request, a commit or the uncommitted changes, and keeps the rest as the focus', () => {
    expect(parseReviewArgs('')).toEqual({ target: { kind: 'uncommitted' }, focus: '' });
    expect(parseReviewArgs('  focus on auth ')).toEqual({ target: { kind: 'uncommitted' }, focus: 'focus on auth' });
    expect(parseReviewArgs('branch')).toEqual({ target: { kind: 'branch' }, focus: '' });
    expect(parseReviewArgs('Branch the parser')).toEqual({ target: { kind: 'branch' }, focus: 'the parser' });
    expect(parseReviewArgs('pr 12')).toEqual({ target: { kind: 'pr', number: 12 }, focus: '' });
    expect(parseReviewArgs('pr #7 error handling')).toEqual({ target: { kind: 'pr', number: 7 }, focus: 'error handling' });
    expect(parseReviewArgs('pr')).toEqual({ target: { kind: 'pr', number: null }, focus: '' });
    expect(parseReviewArgs('pr twelve')).toEqual({ target: { kind: 'pr', number: null }, focus: 'twelve' });
    expect(parseReviewArgs('A1B2C3D the cache')).toEqual({ target: { kind: 'commit', rev: 'a1b2c3d' }, focus: 'the cache' });
    // Hex letters without a digit are a word, and a short hash is too short to be one.
    expect(parseReviewArgs('added tests')).toEqual({ target: { kind: 'uncommitted' }, focus: 'added tests' });
    expect(parseReviewArgs('abc12')).toEqual({ target: { kind: 'uncommitted' }, focus: 'abc12' });
  });
});

describe('where a review looks', () => {
  it('says so when the folder is not a repository or nothing is uncommitted', async () => {
    await expect(resolveReviewScope(track(makeTempDir()), { kind: 'uncommitted' }, null)).rejects.toMatchObject({ code: 'review_not_git' });
    const repo = track(makeRepo({ 'a.txt': 'one\n' }));
    await expect(resolveReviewScope(repo, { kind: 'uncommitted' }, null)).rejects.toMatchObject({ code: 'nothing_to_review', message: expect.stringContaining('/review branch') as string });
    writeFile(repo, 'new.txt', 'untracked\n');
    expect(await resolveReviewScope(repo, { kind: 'uncommitted' }, null)).toEqual({ kind: 'uncommitted' });
  });

  it('measures a branch from where it left the default branch, as the Changes card does', async () => {
    const repo = track(makeRepo({ 'lib.ts': 'one\n' }));
    const base = gitSync(repo, 'rev-parse', 'HEAD').trim();
    // On the default branch there is no branch to compare: what is uncommitted is the work.
    await expect(resolveReviewScope(repo, { kind: 'branch' }, null)).rejects.toMatchObject({ code: 'nothing_to_review' });
    writeFile(repo, 'lib.ts', 'two\n');
    expect(await resolveReviewScope(repo, { kind: 'branch' }, null)).toEqual({ kind: 'uncommitted' });
    gitSync(repo, 'checkout', '-q', '--', 'lib.ts');

    gitSync(repo, 'switch', '-q', '-c', 'feature');
    await expect(resolveReviewScope(repo, { kind: 'branch' }, null)).rejects.toMatchObject({ code: 'nothing_to_review', message: 'feature has no commits or changes since it left main, so there is nothing to review.' });
    writeFile(repo, 'lib.ts', 'three\n');
    gitSync(repo, 'commit', '-q', '-am', 'change lib');
    // main moves on; the base stays where the branch left it.
    gitSync(repo, 'switch', '-q', 'main');
    writeFile(repo, 'other.ts', 'x\n');
    gitSync(repo, 'add', '-A');
    gitSync(repo, 'commit', '-q', '-m', 'main moves');
    gitSync(repo, 'switch', '-q', 'feature');
    expect(await resolveReviewScope(repo, { kind: 'branch' }, null)).toEqual({ kind: 'branch', branch: 'feature', base: 'main', mergeBase: base });

    gitSync(repo, 'switch', '-q', '--detach');
    await expect(resolveReviewScope(repo, { kind: 'branch' }, null)).rejects.toMatchObject({ code: 'review_detached' });
  });

  it('finds a commit by its hash, and says when there is none', async () => {
    const repo = track(makeRepo({ 'a.txt': 'one\n' }));
    writeFile(repo, 'a.txt', 'two\n');
    gitSync(repo, 'commit', '-q', '-am', 'Second change');
    const sha = gitSync(repo, 'rev-parse', 'HEAD').trim();
    expect(await resolveReviewScope(repo, { kind: 'commit', rev: sha.slice(0, 9) }, null)).toEqual({ kind: 'commit', sha, subject: 'Second change' });
    await expect(resolveReviewScope(repo, { kind: 'commit', rev: '0123456789abc' }, null)).rejects.toMatchObject({ code: 'review_no_commit', message: expect.stringContaining('0123456789abc') as string });
  });

  it('gets a pull request through gh, with a sentence for each way that fails', async () => {
    const repo = track(makeRepo());
    await expect(resolveReviewScope(repo, { kind: 'pr', number: null }, null)).rejects.toMatchObject({ code: 'review_pr_number' });
    await expect(resolveReviewScope(repo, { kind: 'pr', number: 12 }, null)).rejects.toMatchObject({ code: 'gh_missing', message: expect.stringContaining('cli.github.com') as string });
    const signedOut = fakeGh({ 'auth status': { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.' } });
    await expect(resolveReviewScope(repo, { kind: 'pr', number: 12 }, signedOut)).rejects.toMatchObject({ code: 'gh_signed_out', message: expect.stringContaining('gh auth login') as string });
    const missing = fakeGh({ 'auth status': ok('Logged in'), 'pr diff': { code: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 12.\n' } });
    await expect(resolveReviewScope(repo, { kind: 'pr', number: 12 }, missing)).rejects.toMatchObject({
      code: 'gh_pr_failed',
      message: "gh couldn't get pull request #12: GraphQL: Could not resolve to a PullRequest with the number of 12."
    });
    const empty = fakeGh({ 'auth status': ok('Logged in'), 'pr diff': ok('') });
    await expect(resolveReviewScope(repo, { kind: 'pr', number: 12 }, empty)).rejects.toMatchObject({ code: 'nothing_to_review' });

    const token = `ghp_${'A1b2C3d4'.repeat(5)}`;
    const gh = fakeGh({ 'auth status': ok('Logged in'), 'pr diff': ok(`diff --git a/x.ts b/x.ts\n+const key = "${token}";\n`) });
    const scope = await resolveReviewScope(repo, { kind: 'pr', number: 12 }, gh);
    expect(gh.calls).toEqual([['auth', 'status'], ['pr', 'diff', '12', '--color', 'never']]);
    expect(scope).toMatchObject({ kind: 'pr', number: 12, cut: false });
    // The diff goes to a model: the token in it is covered.
    expect(scope.kind === 'pr' && scope.diff).toContain('+const key');
    expect(scope.kind === 'pr' && scope.diff).not.toContain(token);
    const long = fakeGh({ 'auth status': ok('Logged in'), 'pr diff': ok(`+${'x'.repeat(PR_DIFF_LIMIT + 10)}\n`) });
    const cut = await resolveReviewScope(repo, { kind: 'pr', number: 3 }, long);
    expect(cut.kind === 'pr' && [cut.diff.length, cut.cut]).toEqual([PR_DIFF_LIMIT, true]);
  });
});

describe('the message a review sends', () => {
  it('says what to look at, that nothing may change, and to report with ReportFindings', () => {
    const uncommitted = reviewMessage('review', { kind: 'uncommitted' }, 'the cache');
    expect(uncommitted).toContain('Review the uncommitted changes in this repository.');
    expect(uncommitted).toContain('git diff --staged');
    expect(uncommitted).toContain('Read the code around each change');
    expect(uncommitted).toContain("This review is read-only: don't edit files");
    expect(uncommitted).toContain('call ReportFindings once with every finding');
    expect(uncommitted.endsWith('Focus especially on: the cache')).toBe(true);
    const branch = reviewMessage('security', { kind: 'branch', branch: 'feature', base: 'main', mergeBase: 'abc123' }, '');
    expect(branch).toContain('Do a security review of the work on the branch feature since it left main.');
    expect(branch).toContain('git diff abc123');
    expect(branch).toContain('how it could be exploited');
    expect(branch).not.toContain('Focus especially on');
    expect(reviewMessage('review', { kind: 'commit', sha: 'f'.repeat(40), subject: 'Fix it' }, '')).toContain(`Review commit ffffffffffff ("Fix it"). Run git show ${'f'.repeat(40)} to see it.`);
    const pr = reviewMessage('review', { kind: 'pr', number: 12, diff: '+a\n', cut: true }, '');
    expect(pr).toContain('Review pull request #12. Its diff, from gh pr diff 12, is below.');
    expect(pr).toContain('```diff\n+a\n```');
    expect(pr).toContain('The diff was cut at 60,000 characters');
  });

  it('runs a review on the reviewer model, and a security review on the security model when one is set', () => {
    const a = { providerId: 'p', modelId: 'a' };
    const b = { providerId: 'p', modelId: 'b' };
    expect(reviewRole('review', {})).toBeNull();
    expect(reviewRole('review', { reviewer: a, security: b })).toBe('reviewer');
    expect(reviewRole('security', { reviewer: a, security: b })).toBe('security');
    expect(reviewRole('security', { reviewer: a, security: null })).toBe('reviewer');
    expect(reviewRole('security', { security: b })).toBe('security');
  });
});
