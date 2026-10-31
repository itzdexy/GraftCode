import path from 'node:path';
import { GraftError } from '@shared/errors';
import { textOf, type StoredMessage } from '@shared/schemas/messages';
import type { RewindMode, RewindPreview, RewindResult } from '@shared/schemas/rewind';
import type { SessionStore } from '../db/sessionsRepo';
import type { CheckpointService } from '../git/checkpoints';
import { isInside } from '../tools/paths';

export interface RewindDeps {
  store: SessionStore;
  checkpoints: CheckpointService;
  /** Removes messages from seq on (also resets the session's read-before-edit state). */
  truncate(sessionId: string, seq: number): void;
}

function userMessage(store: SessionStore, sessionId: string, messageId: string): StoredMessage {
  const message = store.getMessage(messageId);
  if (!message || message.sessionId !== sessionId) throw new GraftError('message_not_found', 'That message is no longer in this session.');
  if (message.role !== 'user' || message.meta.kind) throw new GraftError('rewind_not_user', 'You can only rewind to one of your own messages.');
  return message;
}

/** Some files of the session's folder, named from it as the transcript names them: a file card's Undo restores just those. */
export interface FileSelection {
  folder: string;
  paths: string[];
}

/** The selected files as the snapshot names them: from its root, with "/". */
function snapshotPaths(root: string, only: FileSelection): string[] {
  return only.paths.map((p) => {
    const abs = path.resolve(only.folder, p);
    if (!isInside(root, abs)) throw new GraftError('rewind_outside', `${p} is not in the folder Graft took the snapshot of, so it can't be restored from it.`);
    return path.relative(root, abs).split(path.sep).join('/');
  });
}

function checkpointFor(deps: RewindDeps, sessionId: string, message: StoredMessage) {
  if (message.meta.checkpointId) {
    try {
      return deps.checkpoints.get(message.meta.checkpointId);
    } catch {
      return null;
    }
  }
  return deps.checkpoints.forMessage(sessionId, message.id);
}

/** What a rewind to just before `messageId` would change; with `only`, what restoring those files would. */
export async function previewRewind(deps: RewindDeps, sessionId: string, messageId: string, only?: FileSelection): Promise<RewindPreview> {
  const message = userMessage(deps.store, sessionId, messageId);
  const removed = deps.store.listMessages(sessionId).filter((m) => m.seq >= message.seq).length;
  const checkpoint = checkpointFor(deps, sessionId, message);
  const files = checkpoint ? (await deps.checkpoints.preview(checkpoint.id, only ? snapshotPaths(checkpoint.repoDir, only) : undefined)).changes : null;
  return { messageId, messagesRemoved: removed, files, restoredText: textOf(message.content) };
}

/**
 * Rewinds to the state just before `messageId`: files from its checkpoint,
 * the conversation by removing that message and everything after it, or both.
 * `only` restores just those files and leaves the conversation alone.
 */
export async function performRewind(deps: RewindDeps, sessionId: string, messageId: string, mode: RewindMode, only?: FileSelection): Promise<RewindResult> {
  const message = userMessage(deps.store, sessionId, messageId);
  if (only && mode !== 'files') throw new GraftError('rewind_files_only', 'Single files are restored without touching the conversation. Choose to restore files only.');
  let files: RewindResult['files'] = null;
  let undo: string | null = null;
  if (mode === 'files' || mode === 'both') {
    const checkpoint = checkpointFor(deps, sessionId, message);
    if (!checkpoint) throw new GraftError('no_checkpoint', 'There is no file checkpoint for that message, so files can\'t be restored.');
    const restored = await deps.checkpoints.restore(checkpoint.id, only ? snapshotPaths(checkpoint.repoDir, only) : undefined);
    files = restored.changes;
    undo = restored.safetyCheckpointId;
  }
  let removed = 0;
  if (mode === 'conversation' || mode === 'both') {
    removed = deps.store.listMessages(sessionId).filter((m) => m.seq >= message.seq).length;
    deps.truncate(sessionId, message.seq);
  }
  return { files, messagesRemoved: removed, restoredText: textOf(message.content), undoCheckpointId: undo };
}
