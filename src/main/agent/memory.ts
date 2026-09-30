import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '../tools/paths';

export interface MemoryFile {
  path: string;
  scope: 'user' | 'project' | 'directory';
  content: string;
}

/** Instruction file names, in priority order; the first found in a directory wins. */
export const MEMORY_FILE_NAMES = ['GRAFT.md', 'AGENTS.md', 'CLAUDE.md'] as const;
const MAX_BYTES = 40_000;

function readCapped(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    const text = fs.readFileSync(file, 'utf8');
    const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    return clean.length > MAX_BYTES ? `${clean.slice(0, MAX_BYTES)}\n… [truncated]` : clean;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function memoryFileIn(dir: string): string | null {
  for (const name of MEMORY_FILE_NAMES) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Loads instruction files: the user's (~/.graft/GRAFT.md), then one per
 * directory from the project root down to the working directory. Deeper
 * directories are loaded lazily, the first time the agent touches a file
 * inside them.
 */
export class MemoryLoader {
  private readonly loadedDirs = new Set<string>();

  constructor(
    private readonly graftHome: string,
    private readonly projectRoot: string,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  private key(dir: string): string {
    const resolved = path.resolve(dir);
    return this.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  initial(cwd: string): MemoryFile[] {
    const files: MemoryFile[] = [];
    const user = readCapped(path.join(this.graftHome, 'GRAFT.md'));
    if (user) files.push({ path: path.join(this.graftHome, 'GRAFT.md'), scope: 'user', content: user });
    const dirs: string[] = [];
    let current = path.resolve(cwd);
    const root = path.resolve(this.projectRoot);
    if (isInside(root, current, this.platform)) {
      for (;;) {
        dirs.unshift(current);
        if (this.key(current) === this.key(root)) break;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    } else {
      dirs.push(root);
    }
    for (const dir of dirs) {
      this.loadedDirs.add(this.key(dir));
      const file = memoryFileIn(dir);
      const content = file ? readCapped(file) : null;
      if (file && content) files.push({ path: file, scope: this.key(dir) === this.key(root) ? 'project' : 'directory', content });
    }
    return files;
  }

  /** Notes from directories first touched by these paths, formatted for a tool result; null if none. */
  notesFor(paths: string[]): string | null {
    const found: MemoryFile[] = [];
    for (const p of paths) {
      let dir = path.dirname(path.resolve(p));
      const chain: string[] = [];
      while (isInside(this.projectRoot, dir, this.platform) && !this.loadedDirs.has(this.key(dir))) {
        chain.unshift(dir);
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      for (const d of chain) {
        this.loadedDirs.add(this.key(d));
        const file = memoryFileIn(d);
        const content = file ? readCapped(file) : null;
        if (file && content) found.push({ path: file, scope: 'directory', content });
      }
    }
    if (found.length === 0) return null;
    return found
      .map((f) => `<project-notes path="${f.path}" scope="directory">\nInstructions for files in this directory:\n${f.content.trim()}\n</project-notes>`)
      .join('\n\n');
  }
}
