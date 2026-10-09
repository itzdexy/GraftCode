import { createHash } from 'node:crypto';
import path from 'node:path';
import { GraftError } from '@shared/errors';
import { EditorDraftSchema, StoredEditorDraftSchema, type EditorDraft } from '@shared/schemas/editorDrafts';
import type { Db } from './database';

/** Recovery copies only; never writes project files or sends drafts to an agent. */
export class EditorDraftsRepo {
  constructor(private readonly db: Db) {}
  list(sessionId: string): Array<EditorDraft & { path: string; updatedAt: number }> {
    const rows = this.db.prepare('SELECT path, data, updated_at FROM editor_drafts WHERE session_id = ? ORDER BY updated_at DESC').all(sessionId) as Array<{ path: string; data: string; updated_at: number }>;
    return rows.map((row) => {
      try { return StoredEditorDraftSchema.parse({ ...JSON.parse(row.data) as object, path: row.path, updatedAt: row.updated_at }); }
      catch { throw new GraftError('draft_recovery_invalid', 'A recovery copy could not be read. Its stored data has been kept; contact support before deleting it.'); }
    });
  }
  save(sessionId: string, name: string, value: EditorDraft | null): void {
    if (path.isAbsolute(name) || name.split(/[\\/]/).some((part) => part === '..' || part.toLowerCase() === '.git')) throw new GraftError('draft_path', 'Draft paths must stay inside the project and outside Git metadata.');
    const file = name.replaceAll('\\', '/');
    if (value === null || value.content === value.original) {
      this.db.prepare('DELETE FROM editor_drafts WHERE session_id = ? AND path = ?').run(sessionId, file); return;
    }
    const draft = EditorDraftSchema.parse(value);
    if ([draft.content, draft.original].some((text) => Buffer.byteLength(text) > 512 * 1024)) throw new GraftError('draft_limit', 'Recovery copies support UTF-8 drafts no larger than 512 KiB. Your draft remains in memory.');
    if (createHash('sha256').update(draft.original).digest('hex') !== draft.revision) throw new GraftError('draft_revision', 'The draft recovery revision does not match its original contents.');
    const exists = this.db.prepare('SELECT 1 FROM editor_drafts WHERE session_id = ? AND path = ?').get(sessionId, file);
    if (!exists && (this.db.prepare('SELECT count(*) AS n FROM editor_drafts').get() as { n: number }).n >= 100) throw new GraftError('draft_limit', 'There are 100 recovery drafts. Save or discard some before backing up another; your current draft stays in memory.');
    this.db.prepare('INSERT INTO editor_drafts(session_id, path, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id, path) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .run(sessionId, file, JSON.stringify(draft), Date.now());
  }
}
