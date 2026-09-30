import { GraftError } from '@shared/errors';
import { runFile } from '../tools/run';
import { push } from './changes';
import { currentBranch, defaultBranch, remoteUrl } from './repo';

export interface PullRequestResult {
  url: string;
  /** "gh": created with the GitHub CLI; "browser": the compare page must be finished in a browser. */
  via: 'gh' | 'browser';
}

/** Web base URL for a git remote (https or scp-style ssh), or null for unknown forms. */
export function webUrlForRemote(remote: string): { host: string; url: string } | null {
  const trimmed = remote.trim().replace(/\.git$/, '');
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(trimmed);
  if (scp) return { host: scp[1]!, url: `https://${scp[1]!}/${scp[2]!}` };
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'ssh:' || url.protocol === 'git:') return { host: url.hostname, url: `https://${url.hostname}${url.pathname}` };
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      url.username = '';
      url.password = '';
      return { host: url.hostname, url: `${url.protocol}//${url.host}${url.pathname}` };
    }
  } catch {
    return null;
  }
  return null;
}

/** Page where a PR/MR for `branch` into `base` can be opened. */
export function compareUrl(remote: string, base: string, branch: string): string | null {
  const web = webUrlForRemote(remote);
  if (!web) return null;
  const b = encodeURIComponent(branch);
  if (web.host.includes('gitlab')) {
    return `${web.url}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${b}&merge_request%5Btarget_branch%5D=${encodeURIComponent(base)}`;
  }
  if (web.host.includes('bitbucket')) return `${web.url}/pull-requests/new?source=${b}&dest=${encodeURIComponent(base)}`;
  return `${web.url}/compare/${encodeURIComponent(base)}...${b}?expand=1`;
}

export interface PrOptions {
  title?: string;
  body?: string;
  /** Path to the gh CLI, or null when it isn't installed. */
  ghPath: string | null;
}

/**
 * Pushes the branch, then opens a pull request with the GitHub CLI when it's
 * installed and signed in; otherwise returns the host's compare page URL.
 */
export async function createPullRequest(workDir: string, options: PrOptions): Promise<PullRequestResult> {
  const branch = await currentBranch(workDir);
  if (!branch) throw new GraftError('detached_head', 'Check out a branch before creating a pull request.');
  const base = (await defaultBranch(workDir)) ?? 'main';
  if (branch === base) throw new GraftError('pr_on_base', `You're on ${base}. Create a branch (or use a worktree) for this work first.`);
  const remote = await remoteUrl(workDir);
  if (!remote) throw new GraftError('no_remote', 'This repository has no "origin" remote to open a pull request against.');
  await push(workDir);

  if (options.ghPath) {
    const auth = await runFile(options.ghPath, ['auth', 'status'], { cwd: workDir, timeoutMs: 20_000 });
    if (auth.code === 0) {
      const args = ['pr', 'create', '--head', branch, '--base', base];
      if (options.title) args.push('--title', options.title, '--body', options.body ?? '');
      else args.push('--fill');
      const created = await runFile(options.ghPath, args, { cwd: workDir, timeoutMs: 60_000 });
      const url = /(https?:\/\/\S+)/.exec(created.stdout)?.[1];
      if (created.code === 0 && url) return { url, via: 'gh' };
      const existing = /(https?:\/\/\S+\/pull\/\d+)/.exec(created.stderr)?.[1];
      if (existing) return { url: existing, via: 'gh' };
      throw new GraftError('pr_failed', `gh couldn't create the pull request: ${created.stderr.trim() || created.stdout.trim()}`);
    }
  }
  const url = compareUrl(remote, base, branch);
  if (!url) throw new GraftError('pr_unknown_host', `Don't know how to open a pull request for ${remote}. Open it on your git host.`);
  return { url, via: 'browser' };
}
