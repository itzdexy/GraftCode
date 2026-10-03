import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { makeDir, refusedChange } from '../../files/makeDir';
import { unifiedDiff } from '../diffUtil';
import type { FileStateTracker } from '../fileState';
import { displayPath, resolvePath } from '../paths';
import { errorResult, textResult, type ToolDefinition } from '../types';

export const WriteInput = z.object({
  file_path: z.string().min(1).describe('Path of the file to create or replace.'),
  content: z.string().describe('The complete new file contents.')
});
export type WriteInput = z.infer<typeof WriteInput>;

/** Writes via a temp file + rename so readers never see a half-written file. */
export async function writeFileAtomic(abs: string, content: string): Promise<void> {
  await makeDir(path.dirname(abs));
  const temp = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomUUID().slice(0, 8)}.graft-tmp`);
  try {
    await fs.promises.writeFile(temp, content, 'utf8');
  } catch (error) {
    throw refusedChange(abs, error, 'write');
  }
  try {
    await fs.promises.rename(temp, abs);
  } catch (error) {
    await fs.promises.rm(temp, { force: true });
    throw error;
  }
}

/** Shared freshness gate for tools that modify an existing file. */
export function freshnessError(files: FileStateTracker, abs: string, shown: string, verb: string): string | null {
  const check = files.check(abs);
  if (check.ok) return null;
  if (check.reason === 'not-read') return `Read ${shown} before ${verb} it.`;
  if (check.reason === 'modified') return `${shown} changed since you last read it. Read it again before ${verb} it.`;
  return `${shown} no longer exists.`;
}

export const writeTool: ToolDefinition<WriteInput> = {
  name: 'Write',
  description: [
    'Create a file or replace its entire contents.',
    'For an existing file you must Read it first; prefer Edit for targeted changes.',
    'Parent directories are created as needed.'
  ].join(' '),
  input: WriteInput,
  permissionClass: 'write',
  concurrencySafe: () => false,
  timeoutMs: 30_000,
  async describe(input, ctx) {
    const abs = resolvePath(input.file_path, ctx.cwd);
    const shown = displayPath(abs, ctx.projectRoot, ctx.platform);
    const before = await fs.promises.readFile(abs, 'utf8').catch(() => null);
    const { patch } = unifiedDiff(shown, before ?? '', input.content);
    return {
      summary: `${before === null ? 'Create' : 'Write'} ${shown}`,
      writes: [abs],
      preview: { kind: 'edit', path: abs, patch, created: before === null }
    };
  },
  async execute(input, ctx) {
    const abs = resolvePath(input.file_path, ctx.cwd);
    const shown = displayPath(abs, ctx.projectRoot, ctx.platform);
    let before: string | null = null;
    try {
      const stat = await fs.promises.stat(abs);
      if (stat.isDirectory()) return errorResult(`${shown} is a directory.`);
      const stale = freshnessError(ctx.files, abs, shown, 'overwriting');
      if (stale) return errorResult(stale);
      before = await fs.promises.readFile(abs, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await writeFileAtomic(abs, input.content);
    ctx.files.record(abs);
    const diff = unifiedDiff(shown, before ?? '', input.content);
    const lines = input.content.length === 0 ? 0 : input.content.split(/\r?\n/).length;
    const message = before === null ? `Created ${shown} (${lines} lines).` : `Wrote ${shown} (${lines} lines).`;
    const notes = ctx.notesForPaths([abs]);
    return textResult(notes ? `${message}\n\n${notes}` : message, {
      kind: 'edit',
      path: shown,
      created: before === null,
      patch: diff.patch,
      added: diff.added,
      removed: diff.removed
    });
  }
};
