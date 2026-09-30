import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Expands ~ and resolves against cwd. Never touches the filesystem. */
export function resolvePath(input: string, cwd: string, home: string = os.homedir()): string {
  let p = input.trim();
  if (p === '~') p = home;
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = path.join(home, p.slice(2));
  return path.resolve(cwd, p);
}

function normalizeForCompare(p: string, platform: NodeJS.Platform): string {
  const n = path.resolve(p).replace(/[\\/]+$/, '');
  return platform === 'win32' ? n.toLowerCase() : n;
}

/** True when target equals root or lies inside it (case-insensitive on Windows). */
export function isInside(root: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const r = normalizeForCompare(root, platform);
  const t = normalizeForCompare(target, platform);
  if (t === r) return true;
  const rel = path.relative(r, t);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Real path of `p`, following symlinks. For paths that don't exist yet, the
 * nearest existing ancestor is resolved and the rest re-appended — so a new
 * file under a symlinked directory is judged by where it would really land.
 */
export function realPath(p: string): string {
  const resolved = path.resolve(p);
  const missing: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return missing.length > 0 ? path.join(real, ...missing.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Symlink-safe inside check: compares real paths, so a link inside the root
 * pointing elsewhere counts as outside, and a symlinked root still contains
 * its own files.
 */
export function isInsideReal(root: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  return isInside(realPath(root), realPath(target), platform);
}

/** Path for display: relative to root when inside, else absolute with ~ for home. */
export function displayPath(abs: string, root: string, platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  if (isInside(root, abs, platform)) {
    const rel = path.relative(root, abs);
    return rel.length === 0 ? '.' : rel.split(path.sep).join('/');
  }
  if (isInside(home, abs, platform)) return `~/${path.relative(home, abs).split(path.sep).join('/')}`;
  return abs;
}

export function pathKeyFor(p: string, platform: NodeJS.Platform = process.platform): string {
  return normalizeForCompare(p, platform);
}
