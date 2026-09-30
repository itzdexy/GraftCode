import { spawn } from 'node:child_process';
import path from 'node:path';
import { GraftError } from '@shared/errors';

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

/**
 * Runs git with an argv array (never a shell). Failures throw a GraftError
 * that names the command and includes git's own message.
 */
export function runGit(args: string[], options: GitOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: gitEnv(options.env),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 120_000);
    const onAbort = (): void => {
      child.kill();
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
