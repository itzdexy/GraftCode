import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Creates a temp directory whose path contains a space and parentheses, like real Windows folders. */
export function makeTempDir(prefix = 'graft test (tmp) '): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  // On Windows a process that was just ended (a language server whose folder this is) holds the folder a moment
  // longer, and under a full run that moment outlasted five tries. Retry up to 30 times with 100 ms delay.
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
}

export function writeFile(root: string, relative: string, content: string | Buffer): string {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}
