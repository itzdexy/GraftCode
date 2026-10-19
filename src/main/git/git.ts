import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { GraftError } from '@shared/errors';
import { findCommand } from '../mcp/integrations';

export interface GitOptions {
  cwd: string;
  env?: Record<string, string>;
  /** Written to stdin (e.g. a patch for `git apply`). */
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Resolve instead of throwing on a non-zero exit. */
  allowFail?: boolean;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Environment that keeps git non-interactive and its output stable to parse. */
function gitEnv(extra: Record<string, string> | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    LC_ALL: 'C',
    ...extra
  };
}

let gitPath: string | null = null;

/** Forgets the git program found earlier (tests). */
export function resetGitBinary(): void {
  gitPath = null;
}

/**
 * The git program: from PATH, or from where Git's installers put it when PATH
 * doesn't have it (Git for Windows offers to leave PATH alone, and apps opened
 * from the macOS Finder get a short PATH).
 */
export function gitBinary(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string {
  if (gitPath) return gitPath;
  const onPath = findCommand('git', platform, env, exists);
  const programFiles = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs') : undefined].filter(
    (d): d is string => typeof d === 'string' && d.length > 0
  );
  const known =
    platform === 'win32'
      ? programFiles.flatMap((d) => [path.win32.join(d, 'Git', 'cmd', 'git.exe'), path.win32.join(d, 'Git', 'bin', 'git.exe')])
      : ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'];
  gitPath = onPath ?? known.find((p) => exists(p)) ?? 'git';
  return gitPath;
}

/**
 * Stops a git that was started, and on Windows what it started. The git.exe Git
 * for Windows puts on PATH (`Git\cmd\git.exe`) is a launcher whose child is the
 * real git: killing the launcher alone left that one running through a whole
 * folder, holding a session's private index (Delete failed with EPERM on it) and
 * the output pipes, so a stopped snapshot didn't end either.
 */
function stopGit(child: ChildProcess): void {
  if (process.platform !== 'win32' || child.pid === undefined) {
    child.kill();
    return;
  }
  const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  // taskkill fails for a process that has already ended; one that can't run at all still stops the launcher.
  killer.on('error', () => child.kill());
}

/**
 * Runs git with an argv array (never a shell). Failures throw a GraftError
 * that names the command and includes git's own message. A stop (the signal)
 * ends the call at once, without waiting for git to be gone.
 */
export function runGit(args: string[], options: GitOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    // spawn reports a missing working folder as ENOENT too, which would read as "git is missing".
    if (!fs.existsSync(options.cwd)) {
      reject(new GraftError('folder_missing', `The folder ${options.cwd} doesn't exist anymore.`));
      return;
    }
    const child = spawn(gitBinary(), args, {
      cwd: options.cwd,
      env: gitEnv(options.env),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    const timer = setTimeout(() => stopGit(child), options.timeoutMs ?? 120_000);
    const onAbort = (): void => {
      clearTimeout(timer);
      stopGit(child);
      const reason: unknown = options.signal?.reason;
      reject(reason instanceof Error ? reason : new GraftError('interrupted', 'Git was interrupted.', { cause: reason }));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      reject(
        new GraftError(missing ? 'git_missing' : 'git_failed', missing ? 'Git is not installed or not on PATH.' : `Couldn't run git: ${error.message}`, {
          cause: error
        })
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (options.signal?.aborted) {
        const reason: unknown = options.signal.reason;
        reject(reason instanceof Error ? reason : new GraftError('interrupted', 'Git was interrupted.', { cause: reason }));
        return;
      }
      const result = { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code };
      if (code === 0 || options.allowFail) {
        resolve(result);
        return;
      }
      const message = result.stderr.trim().split('\n').slice(-3).join(' ') || `exit code ${String(code)}`;
      reject(new GraftError('git_failed', `git ${args[0] ?? ''} failed: ${message}`, { details: { command: `git ${args.join(' ')}`.slice(0, 300) } }));
    });
    child.stdin.on('error', () => {
      // git may exit before reading stdin; its exit code reports the outcome.
    });
    child.stdin.end(options.input ?? '');
  });
}

export async function git(args: string[], options: GitOptions): Promise<string> {
  return (await runGit(args, options)).stdout;
}

/** Converts a path printed by git (forward slashes) to the platform form. */
export function fromGitPath(p: string): string {
  return path.normalize(p.trim());
}
