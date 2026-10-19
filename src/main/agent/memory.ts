import fs from 'node:fs';
import path from 'node:path';
import { isInside } from '../tools/paths';
import { parseFrontmatter } from './frontmatter';

export interface MemoryFile {
  path: string;
  scope: 'user' | 'project' | 'directory';
  content: string;
}

/** Instruction file names, in priority order; the first found in a directory wins. */
export const MEMORY_FILE_NAMES = ['GRAFT.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md'] as const;
const MAX_BYTES = 40_000;

function cap(text: string): string {
  return text.length > MAX_BYTES ? `${text.slice(0, MAX_BYTES)}\n… [truncated]` : text;
}

function readCapped(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    const text = fs.readFileSync(file, 'utf8');
    const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    return cap(clean);
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
 * The project's Cursor rules: the `.cursor/rules/*.mdc` files marked `alwaysApply: true`, in name order,
 * else the older single `.cursorrules` file. Rules scoped by globs or left to the model's choice are
 * skipped, because Graft has no way to honour those conditions.
 *
 * These are another tool's files and optional, so any file or folder that can't be read (locked, denied,
 * deleted mid-read, a dangling link) is skipped rather than allowed to stop the session from starting.
 */
export function cursorRules(dir: string): MemoryFile | null {
  const rulesDir = path.join(dir, '.cursor', 'rules');
  let names: string[];
  try {
    names = fs
      .readdirSync(rulesDir)
      .filter((name) => name.toLowerCase().endsWith('.mdc'))
      .sort();
  } catch {
    names = [];
  }
  const bodies: string[] = [];
  for (const name of names) {
    const text = readOptional(path.join(rulesDir, name));
    if (text === null) continue;
    // parseFrontmatter lowercases keys, so `alwaysApply` arrives as `alwaysapply`.
    const { data, body } = parseFrontmatter(text);
    if (data.alwaysapply === 'true' && body.trim()) bodies.push(body.trim());
  }
  if (bodies.length > 0) return { path: rulesDir, scope: 'project', content: cap(bodies.join('\n\n')) };
  const legacy = path.join(dir, '.cursorrules');
  const text = readOptional(legacy);
  const content = text === null ? '' : cap(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  return content ? { path: legacy, scope: 'project', content } : null;
}

/** A regular file's text, following links; null for anything missing, unreadable or not a file. */
function readOptional(file: string): string | null {
  try {
    if (!fs.statSync(file).isFile()) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
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
      const isRoot = this.key(dir) === this.key(root);
      if (file && content) files.push({ path: file, scope: isRoot ? 'project' : 'directory', content });
      // Cursor rules are the project's setup, not a note for one folder, so only the root's are read.
      const rules = isRoot ? cursorRules(dir) : null;
      if (rules) files.push(rules);
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
