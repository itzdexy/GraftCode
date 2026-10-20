import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDatabase, schemaVersion, type Db } from '../../src/main/db/database';
import { MemorySessionStore } from '../../src/main/db/memorySessionStore';
import { MIGRATIONS } from '../../src/main/db/migrations';
import { EMPTY_SESSION_USAGE, SessionsRepo, type SessionStore } from '../../src/main/db/sessionsRepo';
import type { SessionSummary } from '../../src/shared/schemas/sessions';
import { makeTempDir, removeDir } from '../support/tmp';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = makeTempDir();
  db = openDatabase(path.join(dir, 'graft.db'));
});
afterEach(() => {
  db.close();
  removeDir(dir);
});

const NEW_SESSION = {
  kind: 'code',
  projectId: null,
  worktreePath: null,
  branch: null,
  baseBranch: null,
  model: null,
  effort: null,
  permissionMode: 'ask'
} as const;

interface Bench {
  store: SessionStore;
  /** A fresh session under this bench's title, filed nowhere and not completed. */
  make: (title: string) => string;
  summary: (id: string) => SessionSummary;
}

function makeBench(): Bench {
  const repo = new SessionsRepo(db);
  return {
    store: repo,
    make: (title) => repo.create({ ...NEW_SESSION, title, cwd: dir }).id,
    summary: (id) => repo.getSummary(id)
  };
}

function makeMemoryBench(): Bench {
  const store = new MemorySessionStore();
  let n = 0;
  return {
    store,
    make: (title) => {
      const summary: SessionSummary = {
        id: `memory-${String(++n)}`,
        kind: 'code',
        title,
        status: 'idle',
        pinned: false,
        archived: false,
        unread: false,
        incognito: true,
        groupId: null,
        completedAt: null,
        projectId: null,
        projectPath: null,
        projectName: null,
        cwd: dir,
        worktreePath: null,
        branch: null,
        baseBranch: null,
        model: null,
        effort: null,
        permissionMode: 'ask',
        lastError: null,
        usage: EMPTY_SESSION_USAGE,
        createdAt: 1,
        updatedAt: 1
      };
      store.add(summary);
      return summary.id;
    },
    summary: (id) => store.getSummary(id)
  };
}

describe.each([
  ['in the database', makeBench],
  ['for a chat that is not saved', makeMemoryBench]
])('named groups %s', (_where, make) => {
  it('keeps the groups in the order they were made and renames them in place', () => {
    const { store } = make();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-01T10:00:00Z'));
      const work = store.createGroup('Work');
      vi.setSystemTime(new Date('2026-10-01T11:00:00Z'));
      const research = store.createGroup('Research');
      vi.useRealTimers();
      expect(store.listGroups()).toEqual([work, research]);
      expect(store.renameGroup(work.id, 'Deep work')).toEqual({ ...work, name: 'Deep work' });
      expect(store.listGroups()).toEqual([{ ...work, name: 'Deep work' }, research]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a group that is not there, for renaming and for removing alike', () => {
    const { store } = make();
    expect(() => store.renameGroup('gone', 'x')).toThrow(/does not exist/);
    expect(() => store.deleteGroup('gone')).toThrow(/does not exist/);
    expect(store.listGroups()).toEqual([]);
  });

  it('keeps the sessions of a removed group, out of the group and nothing else', () => {
    const { store, make: fresh, summary } = make();
    const group = store.createGroup('Work');
    const inside = fresh('Inside');
    const outside = fresh('Outside');
    store.updateSession(inside, { groupId: group.id });
    store.deleteGroup(group.id);
    expect(store.listGroups()).toEqual([]);
    expect(summary(inside)).toMatchObject({ title: 'Inside', groupId: null });
    expect(summary(outside)).toMatchObject({ title: 'Outside', groupId: null });
  });
});

describe('filing a session and marking it completed', () => {
  it('writes both down, and neither moves the session up its list', () => {
    const repo = new SessionsRepo(db);
    const group = repo.createGroup('Work');
    const id = repo.create({ ...NEW_SESSION, title: 'A session', cwd: dir }).id;
    const before = repo.getSummary(id).updatedAt;
    repo.updateSession(id, { groupId: group.id });
    expect(repo.getSummary(id)).toMatchObject({ groupId: group.id, completedAt: null, updatedAt: before });
    repo.updateSession(id, { completedAt: 1720000000000 });
    expect(repo.getSummary(id)).toMatchObject({ groupId: group.id, completedAt: 1720000000000, updatedAt: before });
    repo.updateSession(id, { completedAt: null });
    expect(repo.getSummary(id)).toMatchObject({ groupId: group.id, completedAt: null, updatedAt: before });
  });

  it('keeps both through a restart', () => {
    let id: string;
    let groupId: string;
    const first = openDatabase(path.join(dir, 'again.db'));
    try {
      const repo = new SessionsRepo(first);
      groupId = repo.createGroup('Work').id;
      id = repo.create({ ...NEW_SESSION, title: 'A session', cwd: dir }).id;
      repo.updateSession(id, { groupId, completedAt: 1720000000000 });
    } finally {
      first.close();
    }
    const second = openDatabase(path.join(dir, 'again.db'));
    try {
      const repo = new SessionsRepo(second);
      expect(repo.getSummary(id)).toMatchObject({ groupId, completedAt: 1720000000000 });
      expect(repo.listGroups()).toMatchObject([{ id: groupId, name: 'Work' }]);
    } finally {
      second.close();
    }
  });

  it('is added to an installation from 0.6.31 without touching what is stored', async () => {
    const { default: Database } = await import('better-sqlite3');
    const file = path.join(dir, 'old.db');
    const old = new Database(file);
    let sessionId: string;
    try {
      old.pragma('foreign_keys = ON');
      // 0.6.31 shipped schema 9.
      migrate(old, MIGRATIONS.filter((m) => m.version <= 9));
      expect(schemaVersion(old)).toBe(9);
      const repo = new SessionsRepo(old);
      sessionId = repo.create({ ...NEW_SESSION, title: 'Keep me', cwd: dir }).id;
      repo.appendMessage(sessionId, 'user', [{ type: 'text', text: 'Still here.' }], {});
    } finally {
      old.close();
    }
    const upgraded = openDatabase(file);
    try {
      expect(schemaVersion(upgraded)).toBe(MIGRATIONS.at(-1)?.version);
      const repo = new SessionsRepo(upgraded);
      expect(repo.getSummary(sessionId)).toMatchObject({ title: 'Keep me', groupId: null, completedAt: null });
      expect(repo.listMessages(sessionId).map((m) => m.content)).toEqual([[{ type: 'text', text: 'Still here.' }]]);
      const group = repo.createGroup('Work');
      repo.updateSession(sessionId, { groupId: group.id, completedAt: 1 });
      expect(repo.list({ includeArchived: true })).toMatchObject([{ id: sessionId, groupId: group.id, completedAt: 1 }]);
    } finally {
      upgraded.close();
    }
  });
});
