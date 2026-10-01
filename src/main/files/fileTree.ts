import fs from 'node:fs';
import path from 'node:path';
import { GraftError } from '@shared/errors';
import { looksBinary } from '../tools/fs/read';
import { isInsideReal } from '../tools/paths';

/** Read-only browsing of a session's folder for the Files panel. */

export interface TreeEntry {
  name: string;
  /** Relative to the root, "/"-separated. */
  path: string;
  type: 'file' | 'dir';
  size: number | null;
}

export interface FilePreview {
  path: string;
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
  size: number;
}

const MAX_PREVIEW_BYTES = 512 * 1024;
const MAX_ENTRIES = 2000;
const HIDDEN = new Set(['.git']);

function resolveInside(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (!isInsideReal(root, abs)) throw new GraftError('outside_folder', 'That path is outside the session folder.');
  return abs;
}

function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

export async function listDirectory(root: string, rel: string): Promise<TreeEntry[]> {
  const dir = resolveInside(root, rel);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new GraftError('not_found', `${rel || 'The folder'} no longer exists.`);
    if (code === 'ENOTDIR') throw new GraftError('not_a_folder', `${rel} is not a folder.`);
    throw error;
  }
  const out: TreeEntry[] = [];
  for (const entry of entries) {
    if (HIDDEN.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    let size: number | null = null;
    if (entry.isSymbolicLink() || entry.isFile()) {
      try {
        const stat = await fs.promises.stat(abs);
        isDir = stat.isDirectory();
        size = stat.isFile() ? stat.size : null;
      } catch (error) {
        // A dangling symlink: show it as a file that can't be opened.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    out.push({ name: entry.name, path: toRel(root, abs), type: isDir ? 'dir' : 'file', size });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1));
}

export async function readPreview(root: string, rel: string): Promise<FilePreview> {
  const abs = resolveInside(root, rel);
  const stat = await fs.promises.stat(abs).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new GraftError('not_found', `${rel} no longer exists.`);
    throw error;
  });
  if (!stat.isFile()) throw new GraftError('not_a_file', `${rel} is not a file.`);
  if (stat.size > MAX_PREVIEW_BYTES) return { path: rel, content: null, binary: false, tooLarge: true, size: stat.size };
  const buffer = await fs.promises.readFile(abs);
  if (looksBinary(buffer)) return { path: rel, content: null, binary: true, tooLarge: false, size: stat.size };
  return { path: rel, content: buffer.toString('utf8'), binary: false, tooLarge: false, size: stat.size };
}
