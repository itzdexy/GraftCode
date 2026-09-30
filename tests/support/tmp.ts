import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Creates a temp directory whose path contains a space and parentheses, like real Windows folders. */
export function makeTempDir(prefix = 'graft test (tmp) '): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export function writeFile(root: string, relative: string, content: string | Buffer): string {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}
