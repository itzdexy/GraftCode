import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir, writeFile } from './tmp';

export function gitSync(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

/** A fresh repository on branch main with one commit, using a local identity. */
export function makeRepo(files: Record<string, string> = { 'README.md': '# demo\n' }): string {
  const dir = makeTempDir('graft repo (tmp) ');
  gitSync(dir, 'init', '-q', '-b', 'main');
  gitSync(dir, 'config', 'user.name', 'Test User');
  gitSync(dir, 'config', 'user.email', 'test@example.com');
  gitSync(dir, 'config', 'core.autocrlf', 'false');
  gitSync(dir, 'config', 'commit.gpgsign', 'false');
  for (const [file, content] of Object.entries(files)) writeFile(dir, file, content);
  gitSync(dir, 'add', '-A');
  gitSync(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

export function read(dir: string, file: string): string {
  return fs.readFileSync(path.join(dir, file), 'utf8');
}

export function exists(dir: string, file: string): boolean {
  return fs.existsSync(path.join(dir, file));
}
