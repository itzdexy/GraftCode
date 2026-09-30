import { execFile } from 'node:child_process';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a binary with an argv array (never through a shell), capturing
 * output. Non-zero exits resolve normally; only spawn failures reject.
 */
export function runFile(
  file: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal; timeoutMs?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv }
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        windowsHide: true,
        maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
        timeout: options.timeoutMs ?? 60_000,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.env ? { env: options.env } : {}),
        encoding: 'utf8'
      },
      (error, stdout, stderr) => {
        if (error) {
          const err = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
          if (typeof err.code === 'number') {
            resolve({ code: err.code, stdout, stderr });
            return;
          }
          if (err.name === 'AbortError') {
            reject(err);
            return;
          }
          if (err.killed) {
            resolve({ code: null, stdout, stderr: `${stderr}\n(timed out)` });
            return;
          }
          reject(err);
          return;
        }
        resolve({ code: 0, stdout, stderr });
      }
    );
  });
}
