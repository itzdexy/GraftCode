import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionContextState } from '../../src/main/agent/contextState';
import { openDatabase, migrate, type Db } from '../../src/main/db/database';
import { MIGRATIONS } from '../../src/main/db/migrations';
import { SessionsRepo } from '../../src/main/db/sessionsRepo';
import { makeTempDir, removeDir } from '../support/tmp';
import Database from 'better-sqlite3';

let dir: string;
let db: Db;
beforeEach(() => { dir = makeTempDir(); db = openDatabase(path.join(dir, 'graft.db')); });
afterEach(() => { db.close(); removeDir(dir); });
function session(repo: SessionsRepo) {
  return repo.create({ kind: 'code', title: 'test', projectId: null, cwd: dir, worktreePath: null, branch: null, baseBranch: null,
    model: null, effort: null, permissionMode: 'ask' });
}

describe('durable context state', () => {
  it('survives a database restart without replacing stored tool output', () => {
    let repo = new SessionsRepo(db);
    const s = session(repo);
    repo.appendMessage(s.id, 'assistant', [{ type: 'tool_use', id: 'read-1', name: 'Read', input: {} }], {});
    repo.appendMessage(s.id, 'user', [{ type: 'tool_result', toolUseId: 'read-1', isError: false, content: [{ type: 'text', text: 'code '.repeat(1000) }] }], {});
    const state = new SessionContextState(repo, s.id);
    state.setCutoff(3);
    db.close(); db = openDatabase(path.join(dir, 'graft.db')); repo = new SessionsRepo(db);
    const resumed = new SessionContextState(repo, s.id);
    expect(resumed.cutoff).toBe(3);
    expect(JSON.stringify(resumed.output(repo.listMessages(s.id)))).toContain('Run it again');
    expect(JSON.stringify(repo.listMessages(s.id))).toContain('code code code');
    repo.deleteMessagesFrom(s.id, 2);
    expect(new SessionContextState(repo, s.id).cutoff).toBe(2);
    resumed.setCutoff(0);
    expect(new SessionContextState(repo, s.id).cutoff).toBe(0);
    expect(() => resumed.setCutoff(-1)).toThrow();
  });

  it('upgrades the shipped schema with a zero cutoff and preserves conversations', () => {
    db.close();
    db = new Database(path.join(dir, 'old.db'));
    migrate(db, MIGRATIONS.filter((m) => m.version <= 4));
    const repo = new SessionsRepo(db);
    const s = session(repo);
    repo.appendMessage(s.id, 'user', [{ type: 'text', text: 'preserve this task' }], {});
    expect(migrate(db)).toEqual([5, 6, 7, 8]);
    expect(repo.getPruneBeforeSeq(s.id)).toBe(0);
    expect(repo.listMessages(s.id)[0]?.content).toEqual([{ type: 'text', text: 'preserve this task' }]);
  });
});
