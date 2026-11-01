import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContentBlock, StoredMessage } from '../../src/shared/schemas/messages';
import { openDatabase, type Db } from '../../src/main/db/database';
import { MemorySessionStore } from '../../src/main/db/memorySessionStore';
import { EMPTY_SESSION_USAGE } from '../../src/main/db/sessionsRepo';
import { CheckpointService } from '../../src/main/git/checkpoints';
import { performRewind, previewRewind } from '../../src/main/agent/rewind';
import { editOf, undoHunk, withoutHunk } from '../../src/main/agent/turnUndo';
import { unifiedDiff } from '../../src/main/tools/diffUtil';
import { exists, gitSync, makeRepo, read } from '../support/gitRepo';
import { makeTempDir, removeDir, writeFile } from '../support/tmp';

const cleanup: string[] = [];
const track = (dir: string): string => {
  cleanup.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of cleanup.splice(0)) removeDir(dir);
});

const lines = (n: number, change: Record<number, string> = {}): string => `${Array.from({ length: n }, (_, i) => change[i + 1] ?? `line ${String(i + 1)}`).join('\n')}\n`;

describe('one file of a turn, back from its snapshot', () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase(':memory:');
    db.prepare("INSERT INTO sessions (id, kind, title, permission_mode, usage, created_at, updated_at) VALUES ('s1', 'code', 't', 'ask', '{}', 0, 0)").run();
  });
  afterEach(() => db.close());

  it('previews and restores only the files asked for, and leaves every other file as it is', async () => {
    const repo = track(makeRepo({ 'a.txt': 'alpha\n', 'b.txt': 'bravo\n' }));
    const service = new CheckpointService(db, track(makeTempDir()));
    const cp = await service.create('s1', repo, 'm1');
    writeFile(repo, 'a.txt', 'alpha changed\n');
    writeFile(repo, 'b.txt', 'bravo changed\n');
    writeFile(repo, 'c.txt', 'created\n');

    expect((await service.preview(cp.id, ['a.txt'])).changes).toEqual([{ path: 'a.txt', change: 'restore' }]);
    expect((await service.preview(cp.id, ['c.txt', 'nothing.txt'])).changes).toEqual([{ path: 'c.txt', change: 'delete' }]);
    const restored = await service.restore(cp.id, ['a.txt']);
    expect(restored.changes).toEqual([{ path: 'a.txt', change: 'restore' }]);
    expect(read(repo, 'a.txt')).toBe('alpha\n');
    expect(read(repo, 'b.txt')).toBe('bravo changed\n');
    expect(read(repo, 'c.txt')).toBe('created\n');
    // A file the turn made is taken away by itself.
    await service.restore(cp.id, ['c.txt']);
    expect(exists(repo, 'c.txt')).toBe(false);
    expect(read(repo, 'b.txt')).toBe('bravo changed\n');
    // The safety snapshot taken first brings the restored file back.
    await service.restore(restored.safetyCheckpointId, ['a.txt']);
    expect(read(repo, 'a.txt')).toBe('alpha changed\n');
  });

  it('names files from the session folder, which may be inside the snapshot, and refuses any outside it', async () => {
    const repo = track(makeRepo({ 'app/src/x.ts': 'v1\n', 'app/src/y.ts': 'v1\n', 'other.txt': 'v1\n' }));
    const folder = path.join(repo, 'app');
    const checkpoints = new CheckpointService(db, track(makeTempDir()));
    const store = new MemorySessionStore();
    store.add({
      id: 's1', kind: 'code', title: 't', status: 'idle', pinned: false, archived: false, unread: false, incognito: true,
      groupId: null, completedAt: null,
      projectId: null, projectPath: folder, projectName: 'app', cwd: folder, worktreePath: null, branch: null, baseBranch: null,
      model: null, effort: null, permissionMode: 'ask', lastError: null, usage: EMPTY_SESSION_USAGE, createdAt: 0, updatedAt: 0
    });
    const cp = await checkpoints.create('s1', folder, 'pending');
    const turn = store.appendMessage('s1', 'user', [{ type: 'text', text: 'change both' }], { checkpointId: cp.id });
    store.appendMessage('s1', 'assistant', [{ type: 'text', text: 'changed' }], {});
    writeFile(folder, 'src/x.ts', 'v2\n');
    writeFile(folder, 'src/y.ts', 'v2\n');
    const deps = { store, checkpoints, truncate: (sessionId: string, seq: number) => void store.deleteMessagesFrom(sessionId, seq) };

    const preview = await previewRewind(deps, 's1', turn.id, { folder, paths: ['src/x.ts'] });
    expect(preview.files).toEqual([{ path: 'app/src/x.ts', change: 'restore' }]);
    const result = await performRewind(deps, 's1', turn.id, 'files', { folder, paths: ['src/x.ts'] });
    expect(result.files).toEqual([{ path: 'app/src/x.ts', change: 'restore' }]);
    expect(result.messagesRemoved).toBe(0);
    expect(read(folder, 'src/x.ts')).toBe('v1\n');
    expect(read(folder, 'src/y.ts')).toBe('v2\n');
    expect(store.listMessages('s1')).toHaveLength(2);

    await expect(performRewind(deps, 's1', turn.id, 'both', { folder, paths: ['src/y.ts'] })).rejects.toMatchObject({ code: 'rewind_files_only' });
    await expect(previewRewind(deps, 's1', turn.id, { folder, paths: ['../../elsewhere.txt'] })).rejects.toMatchObject({ code: 'rewind_outside' });
    expect(read(folder, 'src/y.ts')).toBe('v2\n');
  });
});

describe('one change of a turn, taken back out of its file', () => {
  it('reverses one hunk of an edit and leaves the others, and later edits elsewhere, alone', () => {
    const before = lines(30);
    const after = lines(30, { 2: 'line 2 CHANGED', 28: 'line 28 CHANGED' });
    const { patch } = unifiedDiff('f.txt', before, after);
    // The user then adds lines at the top: the second hunk is found further down, where it moved.
    const now = `header\nmore\n${after}`;
    expect(withoutHunk(now, patch, 1)).toBe(`header\nmore\n${lines(30, { 2: 'line 2 CHANGED' })}`);
    expect(withoutHunk(after, patch, 0)).toBe(lines(30, { 28: 'line 28 CHANGED' }));
  });

  it('refuses when the lines it wrote changed since, and when there is no such hunk', () => {
    const { patch } = unifiedDiff('f.txt', lines(10), lines(10, { 5: 'agent wrote this' }));
    expect(() => withoutHunk(lines(10, { 5: 'and the user rewrote it' }), patch, 0)).toThrow(expect.objectContaining({ code: 'hunk_changed' }) as Error);
    expect(() => withoutHunk(lines(10, { 5: 'agent wrote this' }), patch, 3)).toThrow(expect.objectContaining({ code: 'hunk_not_found' }) as Error);
  });

  it('keeps a file of CRLF lines in CRLF, though edit patches are kept with LF', () => {
    const { patch } = unifiedDiff('w.txt', 'one\r\ntwo\r\nthree\r\n', 'one\r\nTWO\r\nthree\r\n');
    expect(withoutHunk('one\r\nTWO\r\nthree\r\n', patch, 0)).toBe('one\r\ntwo\r\nthree\r\n');
  });

  describe('in a repository, from the edit the session kept', () => {
    let seq = 0;
    const message = (content: ContentBlock[]): StoredMessage => ({ id: `m${String(++seq)}`, sessionId: 's', seq, role: 'user', content, meta: {}, createdAt: seq });
    const edited = (id: string, file: string, before: string, after: string, created = false): StoredMessage => {
      const { patch, added, removed } = unifiedDiff(file, before, after);
      return message([{ type: 'tool_result', toolUseId: id, content: [], isError: false, display: { kind: 'edit', path: file, created, patch, added, removed } }]);
    };

    it('undoes the hunk in the working file and refuses once its lines are gone', () => {
      const repo = track(makeRepo({ 'src/f.txt': lines(30) }));
      const after = lines(30, { 2: 'line 2 CHANGED', 28: 'line 28 CHANGED' });
      writeFile(repo, 'src/f.txt', after);
      const messages = [edited('e1', 'src/f.txt', lines(30), after)];
      expect(editOf(messages, 'e1')).toMatchObject({ path: 'src/f.txt', created: false });
      expect(editOf(messages, 'e2')).toBeNull();

      expect(undoHunk(repo, messages, 'e1', 0)).toEqual({ path: 'src/f.txt' });
      expect(read(repo, 'src/f.txt')).toBe(lines(30, { 28: 'line 28 CHANGED' }));
      expect(gitSync(repo, 'diff', '--stat')).toContain('1 insertion(+), 1 deletion(-)');
      // Done twice, it finds nothing of what it wrote, and changes nothing.
      expect(() => undoHunk(repo, messages, 'e1', 0)).toThrow(expect.objectContaining({ code: 'hunk_changed' }) as Error);
      expect(read(repo, 'src/f.txt')).toBe(lines(30, { 28: 'line 28 CHANGED' }));
    });

    it('sends a new file, a gone file and one outside the folder elsewhere with a sentence', () => {
      const repo = track(makeRepo());
      writeFile(repo, 'new.txt', 'made\n');
      const made = [edited('n1', 'new.txt', '', 'made\n', true)];
      expect(() => undoHunk(repo, made, 'n1', 0)).toThrow(expect.objectContaining({ code: 'hunk_new_file' }) as Error);
      const gone = [edited('g1', 'gone.txt', 'a\n', 'b\n')];
      expect(() => undoHunk(repo, gone, 'g1', 0)).toThrow(expect.objectContaining({ code: 'hunk_file_missing' }) as Error);
      const outside = [edited('o1', '../outside.txt', 'a\n', 'b\n')];
      expect(() => undoHunk(repo, outside, 'o1', 0)).toThrow(expect.objectContaining({ code: 'hunk_outside' }) as Error);
      expect(fs.existsSync(path.join(repo, 'new.txt'))).toBe(true);
    });
  });
});
