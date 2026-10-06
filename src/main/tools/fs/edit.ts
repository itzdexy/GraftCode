import fs from 'node:fs';
import { z } from 'zod';
import { unifiedDiff } from '../diffUtil';
import { displayPath, resolvePath } from '../paths';
import { errorResult, textResult, type ToolDefinition } from '../types';
import { freshnessError, writeFileAtomic } from './write';

const EditSpec = z.object({
  old_string: z.string().describe('Exact text to replace, including indentation. Must be unique unless replace_all is set.'),
  new_string: z.string().describe('Replacement text.'),
  replace_all: z.boolean().optional().describe('Replace every occurrence instead of requiring a unique match.')
});
export type EditSpec = z.infer<typeof EditSpec>;

export const EditInput = EditSpec.extend({
  file_path: z.string().min(1).describe('Path of the file to edit.')
});
export type EditInput = z.infer<typeof EditInput>;

export const MultiEditInput = z.object({
  file_path: z.string().min(1).describe('Path of the file to edit.'),
  edits: z.array(EditSpec).min(1).max(50).describe('Edits applied in order; each sees the result of the previous one.')
});
export type MultiEditInput = z.infer<typeof MultiEditInput>;

export type EditOutcome = { ok: true; content: string; replacements: number; note?: string } | { ok: false; error: string };

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

function nearMissLine(content: string, needle: string): number | null {
  const firstLine = needle.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!firstLine) return null;
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex((l) => l.trim() === firstLine);
  return index === -1 ? null : index + 1;
}

/** The lines of the file from `line` on, as many as an edit named (at most ten), for an error that shows what is really there. */
function linesFrom(content: string, line: number, wanted: number): string {
  const shown = content
    .split(/\r?\n/)
    .slice(line - 1, line - 1 + Math.min(Math.max(wanted, 1), 10))
    .join('\n');
  return shown.length > 800 ? `${shown.slice(0, 800)}…` : shown;
}

const indentOf = (line: string): string => /^[ \t]*/.exec(line)![0];

/**
 * The fallback when old_string isn't in the file exactly: match it line by line,
 * ignoring each line's leading and trailing whitespace. Models often get the
 * indentation wrong (tabs read as spaces, a block quoted one level off) while the
 * text itself is right. Only a single matching block is accepted, and new_string
 * is shifted to the file's indentation. Returns null when nothing matches.
 */
function applyLooseEdit(content: string, edit: EditSpec): EditOutcome | null {
  const needle = edit.old_string.split(/\r?\n/);
  // A trailing newline in old_string means the line's own ending is replaced too.
  const eatEol = needle.length > 1 && needle.at(-1) === '';
  if (eatEol) needle.pop();
  const wanted = needle.map((l) => l.trim());
  const anchor = wanted.findIndex((l) => l.length > 0);
  if (anchor === -1) return null;

  const lines = content.split('\n');
  const starts: number[] = [];
  for (let i = 0; i <= lines.length - wanted.length; i++) {
    if (wanted.every((w, j) => lines[i + j]!.trim() === w)) starts.push(i);
  }
  if (starts.length === 0) return null;
  if (starts.length > 1) {
    return {
      ok: false,
      error: `old_string was not found exactly, and ignoring indentation it matches ${starts.length} places (lines ${starts.map((s) => s + 1).join(', ')}). Include more surrounding lines so it is unique.`
    };
  }

  const first = starts[0]!;
  const last = first + wanted.length - 1;
  let from = 0;
  for (let i = 0; i < first; i++) from += lines[i]!.length + 1;
  let to = from;
  for (let i = first; i <= last; i++) to += lines[i]!.length + 1;
  // `to` is now past the last line's "\n"; step back over the line ending unless it is replaced too.
  if (!eatEol || last === lines.length - 1) to -= 1;
  if (!eatEol && lines[last]!.endsWith('\r')) to -= 1;
  to = Math.min(to, content.length);

  const theirs = indentOf(needle[anchor]!);
  const ours = indentOf(lines[first + anchor]!);
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const replacement = edit.new_string
    .split(/\r?\n/)
    .map((l) => (theirs !== ours && l.trim().length > 0 && l.startsWith(theirs) ? ours + l.slice(theirs.length) : l))
    .join(eol);
  const next = content.slice(0, from) + replacement + content.slice(to);
  if (next === content) return { ok: false, error: 'The file already has this text; only its indentation differs from new_string. Nothing would change.' };
  const where = first === last ? `line ${first + 1}` : `lines ${first + 1}–${last + 1}`;
  return {
    ok: true,
    content: next,
    replacements: 1,
    note: `The indentation differed from old_string, so it was matched by its text at ${where} and new_string was re-indented to fit.`
  };
}

/**
 * Applies one exact-match replacement. Matches LF-authored edits against CRLF
 * files and keeps the file's line endings.
 */
export function applyEdit(content: string, edit: EditSpec): EditOutcome {
  let oldString = edit.old_string;
  let newString = edit.new_string;
  if (oldString.length === 0) return { ok: false, error: 'old_string is empty. Use Write to create or replace a whole file.' };
  if (oldString === newString) return { ok: false, error: 'old_string and new_string are identical; nothing would change.' };
  if (content.includes('\r\n') && !oldString.includes('\r\n')) {
    oldString = oldString.replace(/\n/g, '\r\n');
    newString = newString.replace(/\r?\n/g, '\r\n');
  }
  const count = countOccurrences(content, oldString);
  if (count === 0) {
    const loose = applyLooseEdit(content, edit);
    if (loose) return loose;
    const line = nearMissLine(content, edit.old_string);
    return {
      ok: false,
      error:
        line !== null
          ? `old_string was not found exactly. Text starting like it is at line ${line}, but something differs. The file has, from line ${line}:\n${linesFrom(content, line, edit.old_string.split(/\r?\n/).length)}\nCopy the text exactly from there.`
          : 'old_string was not found in the file. Read the file again and copy the text exactly, including indentation.'
    };
  }
  if (count > 1 && !edit.replace_all) {
    return {
      ok: false,
      error: `old_string appears ${count} times. Include more surrounding lines so it is unique, or set replace_all to change every occurrence.`
    };
  }
  const next = edit.replace_all ? content.split(oldString).join(newString) : content.replace(oldString, () => newString);
  return { ok: true, content: next, replacements: edit.replace_all ? count : 1 };
}

async function loadForEdit(abs: string, shown: string, ctx: Parameters<ToolDefinition['execute']>[1]): Promise<string | { error: string }> {
  try {
    const stat = await fs.promises.stat(abs);
    if (stat.isDirectory()) return { error: `${shown} is a directory.` };
  } catch {
    return { error: `${shown} does not exist. Use Write to create it.` };
  }
  const stale = freshnessError(ctx.files, abs, shown, 'editing');
  if (stale) return { error: stale };
  return fs.promises.readFile(abs, 'utf8');
}

async function previewEdits(filePath: string, edits: EditSpec[], ctx: { cwd: string; projectRoot: string; platform: NodeJS.Platform }) {
  const abs = resolvePath(filePath, ctx.cwd);
  const shown = displayPath(abs, ctx.projectRoot, ctx.platform);
  const before = await fs.promises.readFile(abs, 'utf8').catch(() => null);
  let patch = '';
  if (before !== null) {
    let current = before;
    for (const edit of edits) {
      const outcome = applyEdit(current, edit);
      if (!outcome.ok) break;
      current = outcome.content;
    }
    patch = unifiedDiff(shown, before, current).patch;
  }
  return {
    summary: `Edit ${shown}`,
    writes: [abs],
    preview: { kind: 'edit' as const, path: abs, patch, created: false }
  };
}

async function runEdits(filePath: string, edits: EditSpec[], ctx: Parameters<ToolDefinition['execute']>[1]) {
  const abs = resolvePath(filePath, ctx.cwd);
  const shown = displayPath(abs, ctx.projectRoot, ctx.platform);
  const loaded = await loadForEdit(abs, shown, ctx);
  if (typeof loaded !== 'string') return errorResult(loaded.error);
  let current = loaded;
  let replacements = 0;
  const looseNotes: string[] = [];
  for (const [i, edit] of edits.entries()) {
    const outcome = applyEdit(current, edit);
    if (!outcome.ok) {
      const which = edits.length > 1 ? `Edit ${i + 1} of ${edits.length}: ` : '';
      const tail = edits.length > 1 ? ' No edits were applied.' : '';
      return errorResult(`${which}${outcome.error}${tail}`);
    }
    current = outcome.content;
    replacements += outcome.replacements;
    if (outcome.note) looseNotes.push(outcome.note);
  }
  await writeFileAtomic(abs, current);
  ctx.files.record(abs);
  const diff = unifiedDiff(shown, loaded, current);
  const message = `Edited ${shown}: ${replacements} replacement${replacements === 1 ? '' : 's'} (+${diff.added} −${diff.removed}).`;
  const notes = [...looseNotes, ctx.notesForPaths([abs])].filter((n) => n).join('\n\n');
  return textResult(notes ? `${message}\n\n${notes}` : message, {
    kind: 'edit',
    path: shown,
    created: false,
    patch: diff.patch,
    added: diff.added,
    removed: diff.removed
  });
}

export const editTool: ToolDefinition<EditInput> = {
  name: 'Edit',
  description: [
    'Replace an exact string in a file you have already Read.',
    'old_string must match exactly (whitespace included) and be unique in the file, unless replace_all is true.',
    'If only the indentation is off, a single block with the same text is still matched and new_string takes the file\'s indentation.',
    'Keep old_string as small as possible while unique.'
  ].join(' '),
  input: EditInput,
  permissionClass: 'write',
  concurrencySafe: () => false,
  timeoutMs: 30_000,
  describe: (input, ctx) => previewEdits(input.file_path, [input], ctx),
  execute: (input, ctx) => runEdits(input.file_path, [input], ctx)
};

export const multiEditTool: ToolDefinition<MultiEditInput> = {
  name: 'MultiEdit',
  description: [
    'Apply several exact-string edits to one file you have already Read, in order, atomically:',
    'if any edit fails, none are applied. Each edit sees the result of the previous one.'
  ].join(' '),
  input: MultiEditInput,
  permissionClass: 'write',
  concurrencySafe: () => false,
  timeoutMs: 30_000,
  describe: (input, ctx) => previewEdits(input.file_path, input.edits, ctx),
  execute: (input, ctx) => runEdits(input.file_path, input.edits, ctx)
};
