import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { GraftError } from '@shared/errors';
import type { FileEdits, TextEdit } from '@shared/schemas/semantic';
import { looksBinary } from '../tools/fs/read';
import { writeFileAtomic } from '../tools/fs/write';
import { editableFile } from './fileTree';

/** The largest file a rename changes, as the language server reads them. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Where each line of `text` starts and where its text ends, with line breaks as a language server counts them (\r\n, \n or \r). */
function lineSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== '\n' && c !== '\r') continue;
    spans.push({ start, end: i });
    if (c === '\r' && text[i + 1] === '\n') i++;
    start = i + 1;
  }
  spans.push({ start, end: text.length });
  return spans;
}

/** `text` with the edits made. Their ranges are in `text` itself and may touch but not overlap; one that does not fit refuses them all. */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  const lines = lineSpans(text);
  const offset = (line: number, column: number): number => {
    const span = lines[line - 1];
    if (!span || column - 1 > span.end - span.start) throw new GraftError('edit_range', 'An edit names a place the file does not have, so nothing was changed.');
    return span.start + column - 1;
  };
  const ranges = edits
    .map((edit) => ({ start: offset(edit.line, edit.column), end: offset(edit.endLine, edit.endColumn), text: edit.text }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let at = 0;
  for (const range of ranges) {
    if (range.end < range.start || range.start < at) throw new GraftError('edit_range', 'Two edits overlap, so nothing was changed.');
    out += text.slice(at, range.start) + range.text;
    at = range.end;
  }
  return out + text.slice(at);
}

/**
 * A rename's edits to files of the session's folder, written all or none. Every file is checked before any is
 * written: one that changed since the language server saw it (its sha256 is no longer `revision`), lies outside the
 * folder or is not UTF-8 text refuses them all. A write that fails part way puts back the files already written.
 */
export async function applyFileEdits(root: string, files: ReadonlyArray<FileEdits & { revision: string }>): Promise<void> {
  if (new Set(files.map((f) => f.file)).size !== files.length) throw new GraftError('edit_files', 'A file was named twice in one rename, so nothing was changed.');
  const planned = files.map((f) => {
    const file = editableFile(root, f.file);
    const before = fs.readFileSync(file);
    if (before.length > MAX_FILE_BYTES) throw new GraftError('editor_file_limit', `${f.file} is larger than 2 MiB, so the rename changed no file.`);
    const text = before.toString('utf8');
    if (looksBinary(before) || !Buffer.from(text, 'utf8').equals(before)) throw new GraftError('editor_encoding', `${f.file} is not UTF-8 text, so the rename changed no file.`);
    if (createHash('sha256').update(before).digest('hex') !== f.revision) {
      throw new GraftError('file_changed', `${f.file} changed on disk while the rename was worked out, so no file was changed. Rename again.`);
    }
    return { file, text, next: applyTextEdits(text, f.edits) };
  });
  const written: typeof planned = [];
  try {
    for (const p of planned) {
      await writeFileAtomic(p.file, p.next, p.text);
      written.push(p);
    }
  } catch (error) {
    for (const p of written.reverse()) await writeFileAtomic(p.file, p.text).catch(() => undefined);
    throw error;
  }
}
