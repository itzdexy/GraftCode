import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { canOpenProjectFile } from '@shared/chatFileTypes';
import { GraftError } from '@shared/errors';
import { looksBinary } from '../tools/fs/read';
import { isInsideReal } from '../tools/paths';
import { writeFileAtomic } from '../tools/fs/write';

/** Browsing and revision-checked text editing in a session's Files panel. */

export interface TreeEntry {
  name: string;
  /** Relative to the root, "/"-separated. */
  path: string;
  type: 'file' | 'dir';
  size: number | null;
}

export type MediaKind = 'image' | 'video' | 'audio';

export interface FilePreview {
  /** Present only for complete, losslessly decoded UTF-8 text that can be edited. */
  revision?: string;
  path: string;
  content: string | null;
  binary: boolean;
  /** Text past the limit for text, or a picture or clip past the limit for those. */
  tooLarge: boolean;
  size: number;
  /** A picture, clip or sound: the panel shows it through a preview address instead of as text. */
  media: MediaKind | null;
}

const MAX_PREVIEW_BYTES = 512 * 1024;
/** The largest picture or clip the panel shows; it is read whole to be shown. */
export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

const MEDIA: Record<string, MediaKind> = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.ico': 'image',
  '.avif': 'image',
  '.svg': 'image',
  '.mp4': 'video',
  '.webm': 'video',
  '.mp3': 'audio',
  '.wav': 'audio'
};

/** What kind of picture, clip or sound a file is by its name, or null for anything else. */
export function mediaKindOf(file: string): MediaKind | null {
  return MEDIA[path.extname(file).toLowerCase()] ?? null;
}
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
  const media = mediaKindOf(rel);
  // A picture or clip is shown as what it is, whatever its size as text would be. Only an SVG is also worth reading as text.
  if (media && path.extname(rel).toLowerCase() !== '.svg') return { path: rel, content: null, binary: true, tooLarge: stat.size > MAX_MEDIA_BYTES, size: stat.size, media };
  if (stat.size > MAX_PREVIEW_BYTES) return { path: rel, content: null, binary: false, tooLarge: media ? stat.size > MAX_MEDIA_BYTES : true, size: stat.size, media };
  const buffer = await fs.promises.readFile(abs);
  if (looksBinary(buffer)) return { path: rel, content: null, binary: true, tooLarge: false, size: stat.size, media };
  const content = buffer.toString('utf8');
  const editable = Buffer.from(content, 'utf8').equals(buffer);
  return { path: rel, content, binary: false, tooLarge: false, size: buffer.length, media,
    ...(editable ? { revision: createHash('sha256').update(buffer).digest('hex') } : {}) };
}

/** User-initiated editor save, scoped to an existing text file and its loaded bytes. */
export async function savePreview(root: string, rel: string, content: string, revision: string): Promise<FilePreview> {
  const resolved = resolveInside(root, rel);
  const file = fs.realpathSync(resolved);
  if (!isInsideReal(root, file)) throw new GraftError('outside_folder', 'That path is outside the session folder.');
  if (path.relative(fs.realpathSync(root), file).split(path.sep).some((part) => part.toLowerCase() === '.git')) {
    throw new GraftError('protected_file', 'The editor cannot change Git metadata.');
  }
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_PREVIEW_BYTES || Buffer.byteLength(content) > MAX_PREVIEW_BYTES) throw new GraftError('editor_file_limit', 'Editable files must be regular text files no larger than 512 KiB.');
  const before = fs.readFileSync(file);
  if (looksBinary(before) || !Buffer.from(before.toString('utf8'), 'utf8').equals(before)) throw new GraftError('editor_encoding', 'This file is not losslessly decoded UTF-8 text. Open it in an external editor.');
  if (createHash('sha256').update(before).digest('hex') !== revision) throw new GraftError('file_changed', 'The file changed on disk after this draft was opened. Your draft is kept. Reload and review the latest file before saving.');
  await writeFileAtomic(file, content, before.toString('utf8'));
  const buffer = Buffer.from(content, 'utf8');
  return { path: rel, content, binary: false, tooLarge: false, size: buffer.length, media: mediaKindOf(rel),
    revision: createHash('sha256').update(buffer).digest('hex') };
}

async function statFile(abs: string, rel: string): Promise<fs.Stats | null> {
  try {
    const stat = await fs.promises.stat(abs);
    return stat.isFile() ? stat : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new GraftError('not_found', `${rel} no longer exists.`);
    throw error;
  }
}

/** A picture, clip or sound in the session's folder that is small enough to show: where it is and what it is. */
export async function mediaFile(root: string, rel: string): Promise<{ file: string; kind: MediaKind; size: number }> {
  const file = resolveInside(root, rel);
  const kind = mediaKindOf(rel);
  const stat = kind ? await statFile(file, rel) : null;
  if (!kind || !stat) throw new GraftError('not_media', `${rel} is not a picture, a clip or a sound.`);
  if (stat.size > MAX_MEDIA_BYTES) throw new GraftError('too_large', `${rel} is too large to show here (${String(Math.round(stat.size / 1048576))} MB).`);
  return { file, kind, size: stat.size };
}

/** Whether a click may open a file with the computer's own app for it: documents, pictures, clips and sound, never scripts or programs. */
export const canOpenFile = canOpenProjectFile;

/** A file in the session's folder that is safe to hand to the computer's own app for it. */
export async function openableFile(root: string, rel: string): Promise<string> {
  const file = resolveInside(root, rel);
  if (!(await statFile(file, rel))) throw new GraftError('not_a_file', `${rel} is not a file.`);
  if (!canOpenFile(rel)) {
    throw new GraftError('file_not_openable', 'Graft doesn’t open this kind of file directly, so a click can’t run it. Show it in its folder, or open it in your editor.');
  }
  return file;
}
