import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRun } from '../../src/shared/schemas/agentRuns';
import type { Mission } from '../../src/shared/schemas/missions';
import { createMission } from '../../src/main/agent/mission';
import { migrate, openDatabase, schemaVersion, type Db } from '../../src/main/db/database';
import { MIGRATIONS } from '../../src/main/db/migrations';
import { SessionsRepo } from '../../src/main/db/sessionsRepo';
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

function session(repo: SessionsRepo, title = 'A session'): string {
  return repo.create({ kind: 'code', title, projectId: null, cwd: dir, worktreePath: null, branch: null, baseBranch: null, model: { providerId: 'p1', modelId: 'm1' }, effort: 'medium', permissionMode: 'ask' }).id;
}

function agentRun(sessionId: string, nodeId: string, extra: Partial<AgentRun> = {}): AgentRun {
  return {
    id: `run-${nodeId}`,
    sessionId,
    groupId: 'g1',
    goal: 'Ship it',
    nodeId,
    role: 'explorer',
    roleLabel: 'Explorer',
    title: nodeId,
    prompt: 'Look.',
    dependsOn: [],
    status: 'done',
    rev: 3,
    attempt: 1,
    maxAttempts: 2,
    model: { providerId: 'p1', modelId: 'm1', label: 'Model One' },
    routing: ['The session model.'],
    tools: ['Read'],
    exclusive: false,
    writes: [],
    budget: { maxTokens: null, timeoutMs: 60_000 },
    createdAt: 100,
    startedAt: 110,
    endedAt: 200,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0.001,
    toolCalls: 1,
    toolsUsed: { Read: 1 },
    filesChanged: [],
    result: 'Found it.',
    error: null,
    retries: [],
    verify: null,
    timeline: [{ at: 110, kind: 'start', text: 'Started' }],
    ...extra
  };
}

function mission(sessionId: string, id: string, createdAt: number, extra: Partial<Mission> = {}): Mission {
  return { ...createMission(sessionId, { objective: `Mission ${id}`, criteria: ['works'], checks: ['npm test'], maxTurns: 10 }, id, createdAt), ...extra };
}

describe('agent runs in the database', () => {
  it('keeps each agent’s record, replaces it as it changes, and lists a session’s agents oldest first', () => {
    const repo = new SessionsRepo(db);
    const s = session(repo);
    repo.saveAgentRun(agentRun(s, 'b', { createdAt: 200 }));
    repo.saveAgentRun(agentRun(s, 'a', { createdAt: 100, status: 'running' }));
    repo.saveAgentRun(agentRun(s, 'a', { createdAt: 100, status: 'done', rev: 4 }));
    expect(repo.listAgentRuns(s).map((r) => [r.nodeId, r.status, r.rev])).toEqual([
      ['a', 'done', 4],
      ['b', 'done', 3]
    ]);
    // The whole record comes back as it was stored.
    expect(repo.listAgentRuns(s)[1]).toEqual(agentRun(s, 'b', { createdAt: 200 }));
    expect(repo.listAgentRuns('no-such-session')).toEqual([]);
  });

  it('reads a record written before agents had paths of their own', () => {
    const repo = new SessionsRepo(db);
    const s = session(repo);
    const { writes: _writes, ...older } = agentRun(s, 'old');
    db.prepare('INSERT INTO agent_runs (id, session_id, group_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(older.id, s, older.groupId, JSON.stringify(older), older.createdAt, 1);
    expect(repo.listAgentRuns(s)).toEqual([agentRun(s, 'old')]);
    // Recovering it keeps it readable too.
    db.prepare('UPDATE agent_runs SET data = ? WHERE id = ?').run(JSON.stringify({ ...older, status: 'running' }), older.id);
    expect(repo.recoverAgentRuns()).toBe(1);
    expect(repo.listAgentRuns(s)[0]).toMatchObject({ status: 'cancelled', writes: [] });
  });

  it('removes the agents of the turns a rewind takes away, and those of a deleted session', () => {
    const repo = new SessionsRepo(db);
    const s = session(repo);
    const other = session(repo, 'Other');
    repo.saveAgentRun(agentRun(s, 'early', { createdAt: 100 }));
    repo.saveAgentRun(agentRun(s, 'late', { createdAt: 500 }));
    repo.saveAgentRun(agentRun(other, 'theirs', { id: 'run-theirs', createdAt: 500 }));
    repo.deleteAgentRunsFrom(s, 500);
    expect(repo.listAgentRuns(s).map((r) => r.nodeId)).toEqual(['early']);
    expect(repo.listAgentRuns(other).map((r) => r.nodeId)).toEqual(['theirs']);
    repo.delete(other);
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE session_id = ?').get(other)).toEqual({ n: 0 });
  });

  it('marks agents that were working when Graft closed as stopped, once', () => {
    const repo = new SessionsRepo(db);
    const s = session(repo);
    repo.saveAgentRun(agentRun(s, 'working', { status: 'running', endedAt: null }));
    repo.saveAgentRun(agentRun(s, 'waiting', { status: 'queued', startedAt: null, endedAt: null }));
    repo.saveAgentRun(agentRun(s, 'finished'));
    expect(repo.recoverAgentRuns()).toBe(2);
    const runs = Object.fromEntries(repo.listAgentRuns(s).map((r) => [r.nodeId, r]));
    expect(runs.working).toMatchObject({ status: 'cancelled', rev: 4, error: 'Graft was closed while this agent was working.' });
    expect(runs.working!.endedAt).not.toBeNull();
    expect(runs.waiting).toMatchObject({ status: 'cancelled' });
    expect(runs.finished).toMatchObject({ status: 'done', rev: 3 });
    expect(repo.recoverAgentRuns()).toBe(0);
  });
});

describe('missions in the database', () => {
  it('keeps a mission with its notebook and checks, and gives back the session’s newest', () => {
    const repo = new SessionsRepo(db);
    const s = session(repo);
    expect(repo.getMission(s)).toBeNull();
    const first = mission(s, 'm1', 100, { status: 'done', endedAt: 150 });
    repo.saveMission(first);
    const second = mission(s, 'm2', 300, {
      notebook: [{ kind: 'decision', text: 'Token bucket.', at: 310 }],
      verification: { passed: false, round: 1, runs: [{ command: 'npm test', exitCode: 1, output: 'boom', truncated: false, durationMs: 5, timedOut: false, passed: false }] }
    });
    repo.saveMission(second);
    expect(repo.getMission(s)).toEqual(second);
    repo.saveMission({ ...second, status: 'paused', reason: 'You paused it.', rev: 1, updatedAt: 400 });
    expect(repo.getMission(s)).toMatchObject({ id: 'm2', status: 'paused', rev: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM missions').get()).toEqual({ n: 2 });
  });

  it('removes a mission when a rewind takes its first turn away, bringing back the one before', () => {
    const repo = new SessionsRepo(db);
    const s = session(repo);
    repo.saveMission(mission(s, 'm1', 100, { status: 'done' }));
    repo.saveMission(mission(s, 'm2', 300));
    repo.deleteMissionsFrom(s, 300);
    expect(repo.getMission(s)).toMatchObject({ id: 'm1' });
    repo.deleteMissionsFrom(s, 0);
    expect(repo.getMission(s)).toBeNull();
  });

  it('goes with its session when the session is deleted', () => {
    const repo = new SessionsRepo(db);
    const s = session(repo);
    repo.saveMission(mission(s, 'm1', 100));
    repo.delete(s);
    expect(db.prepare('SELECT COUNT(*) AS n FROM missions').get()).toEqual({ n: 0 });
  });

  it('comes back paused after Graft was closed in the middle of it, with everything it had', () => {
    const repo = new SessionsRepo(db);
    const s = session(repo);
    repo.saveMission(mission(s, 'going', 100, { turns: 4, notebook: [{ kind: 'discovery', text: 'Kept.', at: 120 }] }));
    const done = session(repo, 'Done');
    repo.saveMission(mission(done, 'over', 100, { status: 'done' }));
    expect(repo.recoverMissions(9000)).toBe(1);
    expect(repo.getMission(s)).toMatchObject({ status: 'paused', reason: 'Graft was closed while this mission was running.', turns: 4, notebook: [{ text: 'Kept.' }] });
    expect(repo.getMission(done)).toMatchObject({ status: 'done' });
    expect(repo.recoverMissions(9000)).toBe(0);
  });
});

describe('upgrading an existing installation', () => {
  it('adds the agents and missions tables to a database from 0.6.5 without touching what is in it', async () => {
    const { default: Database } = await import('better-sqlite3');
    const file = path.join(dir, 'old.db');
    const old = new Database(file);
    let sessionId: string;
    try {
      old.pragma('foreign_keys = ON');
      // 0.6.5 shipped schema 2.
      migrate(old, MIGRATIONS.filter((m) => m.version <= 2));
      expect(schemaVersion(old)).toBe(2);
      const repo = new SessionsRepo(old);
      sessionId = session(repo, 'From before the upgrade');
      repo.appendMessage(sessionId, 'user', [{ type: 'text', text: 'Keep me.' }], { typed: 'Keep me.' });
      repo.appendMessage(sessionId, 'assistant', [{ type: 'text', text: 'Kept.' }], {});
      repo.updateSession(sessionId, { todos: [{ id: 't1', content: 'A task', status: 'pending' }], pinned: true });
      old.prepare("INSERT INTO app_settings (section, value) VALUES ('profile', ?)").run(JSON.stringify({ name: 'dexy', avatar: null }));
    } finally {
      old.close();
    }

    // Opening it with this version runs the new migrations.
    const upgraded = openDatabase(file);
    try {
      expect(schemaVersion(upgraded)).toBe(MIGRATIONS.at(-1)?.version);
      const applied = (upgraded.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>).map((row) => row.version);
      expect(applied).toEqual(MIGRATIONS.map((m) => m.version));
      const repo = new SessionsRepo(upgraded);
      expect(repo.getSummary(sessionId)).toMatchObject({ title: 'From before the upgrade', pinned: true });
      expect(repo.listMessages(sessionId).map((m) => m.content)).toEqual([[{ type: 'text', text: 'Keep me.' }], [{ type: 'text', text: 'Kept.' }]]);
      expect(repo.getTodos(sessionId)).toEqual([{ id: 't1', content: 'A task', status: 'pending' }]);
      expect(upgraded.prepare("SELECT value FROM app_settings WHERE section = 'profile'").get()).toEqual({ value: JSON.stringify({ name: 'dexy', avatar: null }) });
      // The session works with what is new.
      expect(repo.listAgentRuns(sessionId)).toEqual([]);
      expect(repo.getMission(sessionId)).toBeNull();
      repo.saveAgentRun(agentRun(sessionId, 'a'));
      repo.saveMission(mission(sessionId, 'm1', 100));
      expect(repo.listAgentRuns(sessionId)).toHaveLength(1);
      expect(repo.getMission(sessionId)).toMatchObject({ id: 'm1' });
      // Opening it again changes nothing.
      expect(migrate(upgraded)).toEqual([]);
    } finally {
      upgraded.close();
    }
  });
});
