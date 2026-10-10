import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, schemaVersion, type Db } from '../../src/main/db/database';
import { MIGRATIONS } from '../../src/main/db/migrations';
import { MemorySessionStore } from '../../src/main/db/memorySessionStore';
import { EMPTY_SESSION_USAGE, SessionsRepo } from '../../src/main/db/sessionsRepo';
import { daysBack, usageDay } from '../../src/shared/usage';
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

function session(repo: SessionsRepo): string {
  return repo.create({ kind: 'code', title: 'A session', projectId: null, cwd: dir, worktreePath: null, branch: null, baseBranch: null, model: { providerId: 'p1', modelId: 'm1' }, effort: 'medium', permissionMode: 'ask' }).id;
}

const tokens = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });

describe('the day a request counts for', () => {
  it('is the date on this computer, not in UTC', () => {
    expect(usageDay(new Date(2026, 9, 7, 0, 5))).toBe('2026-10-07');
    expect(usageDay(new Date(2026, 9, 7, 23, 55))).toBe('2026-10-07');
    expect(usageDay(new Date(2026, 0, 3, 12))).toBe('2026-01-03');
  });

  it('lists the days of a range, oldest first, across a month and a clock change', () => {
    expect(daysBack(new Date(2026, 9, 2, 9), 4)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    // 29 March 2026 has 23 hours where clocks go forward; no day is skipped or repeated.
    expect(daysBack(new Date(2026, 2, 30, 0, 30), 3)).toEqual(['2026-03-28', '2026-03-29', '2026-03-30']);
    expect(daysBack(new Date(2026, 9, 2), 1)).toEqual(['2026-10-02']);
  });
});

describe('usage by day', () => {
  it('adds each request to its day and model', () => {
    const repo = new SessionsRepo(db);
    repo.recordUsage({ day: '2026-10-07', providerId: 'p1', modelId: 'm1', usage: tokens(1000, 50), costUsd: 0.5 });
    repo.recordUsage({ day: '2026-10-07', providerId: 'p1', modelId: 'm1', usage: { inputTokens: 200, outputTokens: 10, cacheReadTokens: 800, cacheWriteTokens: 40 }, costUsd: 0.25 });
    repo.recordUsage({ day: '2026-10-07', providerId: 'p2', modelId: 'm9', usage: tokens(5, 5), costUsd: null });
    repo.recordUsage({ day: '2026-10-08', providerId: 'p1', modelId: 'm1', usage: tokens(1, 1), costUsd: 0 });
    const rows = repo.usageSince('2026-10-07');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      day: '2026-10-07',
      providerId: 'p1',
      modelId: 'm1',
      requests: 2,
      usage: { inputTokens: 1200, outputTokens: 60, cacheReadTokens: 800, cacheWriteTokens: 40 },
      costUsd: 0.75,
      unpriced: 0
    });
    // A request whose price nobody published is counted, and its cost is not made up.
    expect(rows[1]).toMatchObject({ day: '2026-10-07', providerId: 'p2', modelId: 'm9', requests: 1, costUsd: 0, unpriced: 1 });
    // A free request is priced: it cost nothing.
    expect(rows[2]).toMatchObject({ day: '2026-10-08', requests: 1, costUsd: 0, unpriced: 0 });
  });

  it('returns only the days asked for, oldest first', () => {
    const repo = new SessionsRepo(db);
    for (const day of ['2026-10-09', '2026-09-30', '2026-10-01']) repo.recordUsage({ day, providerId: 'p1', modelId: 'm1', usage: tokens(1, 1), costUsd: 0.5 });
    expect(repo.usageSince('2026-10-01').map((r) => r.day)).toEqual(['2026-10-01', '2026-10-09']);
    expect(repo.usageSince('2027-01-01')).toEqual([]);
  });

  it('outlives the session it came from', () => {
    const repo = new SessionsRepo(db);
    const id = session(repo);
    repo.recordUsage({ day: '2026-10-07', providerId: 'p1', modelId: 'm1', usage: tokens(10, 10), costUsd: 0.25 });
    repo.delete(id);
    expect(repo.usageSince('2026-10-07')).toHaveLength(1);
  });

  it('stays in memory for a store that is never written to disk', () => {
    const store = new MemorySessionStore();
    store.recordUsage({ day: '2026-10-07', providerId: 'p1', modelId: 'm1', usage: tokens(10, 10), costUsd: null });
    store.recordUsage({ day: '2026-10-07', providerId: 'p1', modelId: 'm1', usage: tokens(1, 1), costUsd: 0.5 });
    expect(store.usageSince('2026-10-01')).toEqual([{ day: '2026-10-07', providerId: 'p1', modelId: 'm1', requests: 2, usage: tokens(11, 11), costUsd: 0.5, unpriced: 1 }]);
  });
});

describe('the cutoff for removed tool output', () => {
  it('is kept with the session', () => {
    const repo = new SessionsRepo(db);
    const id = session(repo);
    expect(repo.pruneCutoff(id)).toBe(0);
    const before = repo.getSummary(id).updatedAt;
    repo.setPruneCutoff(id, 42);
    expect(repo.pruneCutoff(id)).toBe(42);
    // It is bookkeeping, not activity: the session keeps its place in the list.
    expect(repo.getSummary(id).updatedAt).toBe(before);
    expect(new SessionsRepo(db).pruneCutoff(id)).toBe(42);
    repo.setPruneCutoff(id, 0);
    expect(repo.pruneCutoff(id)).toBe(0);
  });

  it('is 0 for a session the store does not have', () => {
    expect(new SessionsRepo(db).pruneCutoff('gone')).toBe(0);
    expect(new MemorySessionStore().pruneCutoff('gone')).toBe(0);
  });

  it('is kept by the store in memory too', () => {
    const store = new MemorySessionStore();
    store.setPruneCutoff('s1', 7);
    expect(store.pruneCutoff('s1')).toBe(7);
    store.remove('s1');
    expect(store.pruneCutoff('s1')).toBe(0);
  });
});

describe('upgrading an installation from 0.6.13', () => {
  it('adds the cutoff and the usage table without touching what is stored', async () => {
    const { default: Database } = await import('better-sqlite3');
    const file = path.join(dir, 'old.db');
    const old = new Database(file);
    let sessionId: string;
    try {
      old.pragma('foreign_keys = ON');
      // 0.6.6 to 0.6.13 shipped schema 4.
      migrate(old, MIGRATIONS.filter((m) => m.version <= 4));
      expect(schemaVersion(old)).toBe(4);
      // Written as that version wrote it: the repository of today reads a column the old schema lacks.
      sessionId = 'old-session';
      old
        .prepare(
          `INSERT INTO sessions (id, kind, title, permission_mode, status, usage, created_at, updated_at) VALUES (?, 'code', 'From before the upgrade', 'ask', 'idle', ?, 1, 1)`
        )
        .run(sessionId, JSON.stringify({ ...EMPTY_SESSION_USAGE, costUsd: 1.5 }));
      old.prepare(`INSERT INTO messages (id, session_id, seq, role, content, meta, created_at) VALUES ('m1', ?, 1, 'user', ?, '{}', 1)`).run(sessionId, JSON.stringify([{ type: 'text', text: 'Keep me.' }]));
    } finally {
      old.close();
    }

    const upgraded = openDatabase(file);
    try {
      expect(schemaVersion(upgraded)).toBe(MIGRATIONS.at(-1)?.version);
      const repo = new SessionsRepo(upgraded);
      expect(repo.getSummary(sessionId)).toMatchObject({ title: 'From before the upgrade', usage: { costUsd: 1.5 } });
      expect(repo.listMessages(sessionId).map((m) => m.content)).toEqual([[{ type: 'text', text: 'Keep me.' }]]);
      expect(repo.pruneCutoff(sessionId)).toBe(0);
      // Nothing is invented for the days before the upgrade.
      expect(repo.usageSince('2000-01-01')).toEqual([]);
      repo.recordUsage({ day: '2026-10-10', providerId: 'p1', modelId: 'm1', usage: tokens(3, 4), costUsd: 0.1 });
      expect(repo.usageSince('2026-10-10')).toHaveLength(1);
      expect(migrate(upgraded)).toEqual([]);
    } finally {
      upgraded.close();
    }
  });
});
