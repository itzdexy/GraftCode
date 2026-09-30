import { fromGitPath, git, runGit } from './git';

export interface GitInfo {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
}

export interface BranchInfo {
  name: string;
  current: boolean;
  remote: boolean;
}

export async function gitInfo(dir: string): Promise<GitInfo> {
  const top = await runGit(['rev-parse', '--show-toplevel'], { cwd: dir, allowFail: true });
  if (top.code !== 0) return { isRepo: false, root: null, branch: null };
  return { isRepo: true, root: fromGitPath(top.stdout), branch: await currentBranch(dir) };
}

export async function repoRoot(dir: string): Promise<string> {
  return fromGitPath(await git(['rev-parse', '--show-toplevel'], { cwd: dir }));
}

/** Branch name, or null when HEAD is detached or the repo has no commits on a branch yet. */
export async function currentBranch(dir: string): Promise<string | null> {
  const result = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: dir, allowFail: true });
  const name = result.stdout.trim();
  return result.code === 0 && name.length > 0 ? name : null;
}

export async function headCommit(dir: string): Promise<string | null> {
  const result = await runGit(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: dir, allowFail: true });
  return result.code === 0 ? result.stdout.trim() : null;
}

/** The branch changes are compared against: origin's HEAD, else main/master when present. */
export async function defaultBranch(dir: string): Promise<string | null> {
  const remoteHead = await runGit(['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], { cwd: dir, allowFail: true });
  if (remoteHead.code === 0 && remoteHead.stdout.trim()) return remoteHead.stdout.trim().replace(/^origin\//, '');
  for (const candidate of ['main', 'master', 'trunk', 'develop']) {
    const exists = await runGit(['rev-parse', '--verify', '-q', `refs/heads/${candidate}`], { cwd: dir, allowFail: true });
    if (exists.code === 0) return candidate;
  }
  return null;
}

export async function listBranches(dir: string): Promise<BranchInfo[]> {
  const out = await git(['for-each-ref', '--format=%(refname)%09%(HEAD)', 'refs/heads', 'refs/remotes'], { cwd: dir });
  const branches: BranchInfo[] = [];
  for (const line of out.split('\n')) {
    const [ref, head] = line.split('\t');
    if (!ref) continue;
    if (ref.endsWith('/HEAD')) continue;
    const remote = ref.startsWith('refs/remotes/');
    branches.push({ name: ref.replace(/^refs\/(heads|remotes)\//, ''), current: head === '*', remote });
  }
  return branches.sort((a, b) => Number(b.current) - Number(a.current) || Number(a.remote) - Number(b.remote) || a.name.localeCompare(b.name));
}

export async function remoteUrl(dir: string, remote = 'origin'): Promise<string | null> {
  const result = await runGit(['remote', 'get-url', remote], { cwd: dir, allowFail: true });
  return result.code === 0 ? result.stdout.trim() : null;
}

/** Switches the working tree to a branch; refuses when that would clobber local changes (git's own check). */
export async function checkoutBranch(dir: string, branch: string, create: boolean): Promise<void> {
  await git(create ? ['switch', '-c', branch] : ['switch', branch], { cwd: dir });
}

/** Absolute path git uses for a repo-internal file (worktree-aware), e.g. "index". */
export async function gitPath(dir: string, name: string): Promise<string> {
  const out = await git(['rev-parse', '--path-format=absolute', '--git-path', name], { cwd: dir });
  return fromGitPath(out);
}
