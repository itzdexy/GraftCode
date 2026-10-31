import fs from 'node:fs';
import { applyPatch, parsePatch, reversePatch } from 'diff';
import { GraftError } from '@shared/errors';
import type { StoredMessage } from '@shared/schemas/messages';
import { isInsideReal, resolvePath } from '../tools/paths';

/**
 * Undo of one change of a turn: a hunk of one edit's patch, taken back out of
 * the file it changed. Only those lines change; the user's later edits
 * elsewhere in the file stay. (A whole file goes back through its turn's
 * snapshot instead: see rewind.ts.)
 */

/** The change one edit made, as its tool result keeps it: the file (named from the session's folder) and the patch. */
export function editOf(messages: readonly StoredMessage[], toolUseId: string): { path: string; patch: string; created: boolean } | null {
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_result' && block.toolUseId === toolUseId && !block.isError && block.display?.kind === 'edit') {
        return { path: block.display.path, patch: block.display.patch, created: block.display.created };
      }
    }
  }
  return null;
}

/**
 * `text` with hunk `index` of `patch` taken back out. The lines the hunk wrote
 * must still be as it left them, where it left them or moved by edits
 * elsewhere in the file; otherwise this throws and nothing is changed. The
 * patch's lines end in "\n" (see diffUtil) and a file of "\r\n" lines keeps its own.
 */
export function withoutHunk(text: string, patch: string, index: number): string {
  const parsed = parsePatch(patch)[0];
  const hunk = parsed?.hunks[index];
  if (!parsed || !hunk) throw new GraftError('hunk_not_found', 'That change is no longer part of the edit, so there is nothing to undo.');
  const undone = applyPatch(text, reversePatch({ ...parsed, hunks: [hunk] }), { fuzzFactor: 0 });
  if (undone === false) {
    throw new GraftError('hunk_changed', "The lines this change wrote have been edited since, so it can't be undone on its own. Undo the whole file, or change it by hand.");
  }
  return undone;
}

/** Takes hunk `index` of the edit made by `toolUseId` back out of its file in `folder`. */
export function undoHunk(folder: string, messages: readonly StoredMessage[], toolUseId: string, index: number): { path: string } {
  const edit = editOf(messages, toolUseId);
  if (!edit) throw new GraftError('hunk_not_found', 'That change is no longer in this session, so there is nothing to undo.');
  if (edit.created) throw new GraftError('hunk_new_file', `${edit.path} was created by that change: undo the whole file instead.`);
  const file = resolvePath(edit.path, folder);
  // A link inside the folder that leads out of it is outside it too.
  if (!isInsideReal(folder, file)) throw new GraftError('hunk_outside', `${edit.path} is outside this session's folder, so Graft doesn't change it from here.`);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new GraftError('hunk_file_missing', `${edit.path} no longer exists, so the change can't be undone.`);
    throw error;
  }
  fs.writeFileSync(file, withoutHunk(text, edit.patch, index));
  return { path: edit.path };
}
