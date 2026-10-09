import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/main/db/database';
import { EditorDraftsRepo } from '../../src/main/db/editorDraftsRepo';
import { SessionsRepo } from '../../src/main/db/sessionsRepo';
import { makeTempDir, removeDir } from '../support/tmp';

let dir: string, db: Db, id: string;
const draft = { original: '\ufeffbefore\r\n', content: '\ufeffunsaved\r\n', revision: createHash('sha256').update('\ufeffbefore\r\n').digest('hex') };
beforeEach(() => {
  dir = makeTempDir(); db = openDatabase(path.join(dir, 'graft.db'));
  id = new SessionsRepo(db).create({ kind: 'code', title: 'editor', projectId: null, cwd: dir, worktreePath: null, branch: null, baseBranch: null, model: null, effort: null, permissionMode: 'ask' }).id;
});
afterEach(() => { db.close(); removeDir(dir); });
describe('durable editor recovery copies', () => {
  it('preserves contents and the original revision across restart and cascades with session deletion', () => {
    new EditorDraftsRepo(db).save(id, 'notes.txt', draft);
    db.close(); db = openDatabase(path.join(dir, 'graft.db'));
    expect(new EditorDraftsRepo(db).list(id)).toMatchObject([{ path: 'notes.txt', ...draft }]);
    new SessionsRepo(db).delete(id);
    expect(new EditorDraftsRepo(db).list(id)).toEqual([]);
  });
  it('rejects paths, oversized UTF-8 and forged original revisions without losing an existing backup', () => {
    const repo = new EditorDraftsRepo(db); repo.save(id, 'notes.txt', draft);
    expect(() => repo.save(id, '../outside', draft)).toThrow(/inside/);
    expect(() => repo.save(id, '.git/config', draft)).toThrow(/Git/);
    expect(() => repo.save(id, 'notes.txt', { ...draft, revision: 'f'.repeat(64) })).toThrow(/revision/);
    expect(() => repo.save(id, 'notes.txt', { ...draft, content: '字'.repeat(200_000) })).toThrow(/512/);
    expect(repo.list(id)[0]).toMatchObject(draft);
  });
  it('bounds recovery storage and permits updating, saving and discarding existing buffers at the limit', () => {
    const repo = new EditorDraftsRepo(db);
    for (let i = 0; i < 100; i++) repo.save(id, `${i}.txt`, draft);
    expect(() => repo.save(id, 'overflow.txt', draft)).toThrow(/100/);
    repo.save(id, '0.txt', { ...draft, content: 'updated' });
    repo.save(id, '1.txt', { ...draft, content: draft.original });
    repo.save(id, '2.txt', null);
    repo.save(id, 'overflow.txt', draft);
    expect(repo.list(id)).toHaveLength(99);
  });
  it('reports corrupt recovery metadata while preserving its stored bytes', () => {
    const repo = new EditorDraftsRepo(db); repo.save(id, 'notes.txt', draft);
    db.prepare('UPDATE editor_drafts SET data = ? WHERE session_id = ?').run('{', id);
    expect(() => repo.list(id)).toThrow(/kept/);
    expect(db.prepare('SELECT data FROM editor_drafts WHERE session_id = ?').get(id)).toEqual({ data: '{' });
  });
});
