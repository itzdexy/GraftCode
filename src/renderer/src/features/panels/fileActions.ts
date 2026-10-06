import { canOpenProjectFile } from '@shared/chatFileTypes';
import { fileSize } from '../../lib/format';

/**
 * What can be done with a file or folder of the session's folder from the
 * Files panel and the transcript, and the text those actions need.
 */

export type FileAction = 'copy-path' | 'copy-relative' | 'copy-image' | 'reveal' | 'open' | 'editor' | 'mention';

/** Pictures the clipboard takes as pictures (the main process decodes these). */
const COPYABLE_IMAGE = /\.(png|jpe?g)$/i;

/** The full path of something in a folder, written the way the computer writes paths. */
export function absolutePath(folder: string, rel: string, platform: string): string {
  const sep = platform === 'win32' ? '\\' : '/';
  const base = folder.replace(/[\\/]+$/, '');
  const joined = rel.length > 0 ? `${base}/${rel}` : base;
  return platform === 'win32' ? joined.replace(/\//g, sep) : joined;
}

/** A path as a mention the agent follows ("@path"; quoted when it has spaces). */
export function mentionOf(rel: string): string {
  return /\s/.test(rel) ? `@"${rel}"` : `@${rel}`;
}

/** A draft with a file mentioned at its end, and a space after it to keep typing. */
export function withMention(draft: string, rel: string): string {
  const gap = draft.length === 0 || /\s$/.test(draft) ? '' : ' ';
  return `${draft}${gap}${mentionOf(rel)} `;
}

/** The actions a file or folder gets, in menu order. Opening is offered only for what a click can't run. */
export function actionsFor(entry: { path: string; type: 'file' | 'dir' }): FileAction[] {
  const file = entry.type === 'file';
  return [
    'copy-path',
    'copy-relative',
    ...(file && COPYABLE_IMAGE.test(entry.path) ? (['copy-image'] as const) : []),
    'reveal',
    ...(file && canOpenProjectFile(entry.path) ? (['open'] as const) : []),
    'editor',
    'mention'
  ];
}

/** The line beside a previewed file's path: a picture's size in pixels once it has loaded, and its size on disk. */
export function previewNote(preview: { size: number; media: 'image' | 'video' | 'audio' | null }, pixels: { width: number; height: number } | null): string {
  return pixels && preview.media === 'image' ? `${String(pixels.width)} × ${String(pixels.height)} · ${fileSize(preview.size)}` : fileSize(preview.size);
}
