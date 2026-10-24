import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toLlmHistory } from '../../src/main/agent/history';
import { NOT_FINISHED, NOT_RUN, OUTCOME_UNKNOWN, reconcileInterrupted, RECORDED_NOTE, type JournalStart } from '../../src/main/agent/journal';
import { migrate, openDatabase, schemaVersion, type Db } from '../../src/main/db/database';
import { MemorySessionStore } from '../../src/main/db/memorySessionStore';
import { MIGRATIONS } from '../../src/main/db/migrations';
import { EMPTY_SESSION_USAGE, SessionsRepo, type SessionStore } from '../../src/main/db/sessionsRepo';
import type { ContentBlock, ToolResultBlock } from '../../src/shared/schemas/messages';
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

const NEW_SESSION = { kind: 'code', title: 'A session', projectId: null, worktreePath: null, branch: null, baseBranch: null, model: { providerId: 'p1', modelId: 'm1' }, effort: 'medium', permissionMode: 'ask' } as const;

function inRepo(repo: SessionsRepo): string {
  return repo.create({ ...NEW_SESSION, cwd: dir }).id;
}

function inMemory(): { store: MemorySessionStore; id: string } {
  const store = new MemorySessionStore();
  const summary: SessionSummary = {
    id: 'memory-1', kind: 'code', title: 'A session', projectId: null, projectPath: null, projectName: null, cwd: dir, worktreePath: null, branch: null, baseBranch: null,
    model: { providerId: 'p1', modelId: 'm1' }, effort: 'medium', permissionMode: 'ask', status: 'idle', pinned: false, archived: false, unread: false, incognito: false, groupId: null, completedAt: null, lastError: null,
    usage: EMPTY_SESSION_USAGE, createdAt: 1, updatedAt: 1
  };
  store.add(summary);
  return { store, id: summary.id };
}

/** A call written down as started, at a minute past the one before. */
let clock = 0;
const started = (sessionId: string, toolUseId: string, more: Partial<JournalStart> = {}): JournalStart => ({
  sessionId, toolUseId, rootId: toolUseId, agent: null, name: 'Shell', summary: `Run ${toolUseId}`, effect: 'change', startedAt: (clock += 60_000), ...more
});
const result = (toolUseId: string, text: string, isError = false): ToolResultBlock => ({ type: 'tool_result', toolUseId, isError, content: [{ type: 'text', text }] });
const calls = (...ids: string[]): ContentBlock[] => ids.map((id) => ({ type: 'tool_use', id, name: 'Shell', input: { command: id } }));
const text = (block: ContentBlock | undefined): string => (block?.type === 'tool_result' ? block.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n') : '');

describe.each([
  ['in the database', (): { store: SessionStore; id: string } => { const repo = new SessionsRepo(db); return { store: repo, id: inRepo(repo) }; }],
  ['for a chat that is not saved', (): { store: SessionStore; id: string } => inMemory()]
])('the journal of tool calls %s', (_where, make) => {
  it('keeps a call from the moment it starts until its result is in the conversation', () => {
    const { store, id } = make();
    expect(store.journalOpen(id)).toEqual([]);
    const intent = started(id, 'call-1');
    store.journalStart(intent);
    // Written down before it ran: what is known is that it started, not how it ended.
    expect(store.journalOpen(id)).toEqual([{ ...intent, endedAt: null, result: null }]);
    store.journalEnd(id, 'call-1', result('call-1', 'done'), intent.startedAt + 500);
    expect(store.journalOpen(id)).toEqual([{ ...intent, endedAt: intent.startedAt + 500, result: result('call-1', 'done') }]);
    store.journalSettle(id, ['call-1']);
    expect(store.journalOpen(id)).toEqual([]);
  });

  it('keeps the calls in the order they started, and forgets what an agent did with the call that started the agent', () => {
    const { store, id } = make();
    store.journalStart(started(id, 'task-1', { name: 'Task', effect: 'read' }));
    store.journalStart(started(id, 'child-1', { rootId: 'task-1', agent: 'Look around', name: 'Glob', effect: 'read' }));
    store.journalStart(started(id, 'call-2'));
    store.journalStart(started(id, 'child-2', { rootId: 'task-1', agent: 'Look around' }));
    expect(store.journalOpen(id).map((e) => e.toolUseId)).toEqual(['task-1', 'child-1', 'call-2', 'child-2']);
    store.journalSettle(id, ['task-1']);
    expect(store.journalOpen(id).map((e) => e.toolUseId)).toEqual(['call-2']);
  });

  it('keeps a result too large to store as the start of its text, without its pictures', () => {
    const { store, id } = make();
    store.journalStart(started(id, 'big'));
    const big: ToolResultBlock = {
      type: 'tool_result', toolUseId: 'big', isError: false,
      content: [{ type: 'text', text: `first line\n${'x'.repeat(300_000)}` }, { type: 'image', mediaType: 'image/png', data: 'A'.repeat(50_000) }],
      display: { kind: 'text', text: 'y'.repeat(1000) }
    };
    store.journalEnd(id, 'big', big, 1);
    const kept = store.journalOpen(id)[0]!.result!;
    expect(kept.isError).toBe(false);
    expect(kept.content).toHaveLength(1);
    expect(text(kept)).toMatch(/^first line\nx+/);
    expect(text(kept)).toMatch(/\[The rest of this result was not kept\.\]$/);
    expect(JSON.stringify(kept).length).toBeLessThan(30_000);
  });

  it('takes the same call twice as the later one, and an ending for a call nobody started as nothing', () => {
    const { store, id } = make();
    store.journalStart(started(id, 'again', { summary: 'first' }));
    store.journalStart(started(id, 'again', { summary: 'second' }));
    store.journalEnd(id, 'never-started', result('never-started', 'x'), 1);
    expect(store.journalOpen(id).map((e) => e.summary)).toEqual(['second']);
  });
});

describe('the journal after the app stops', () => {
  it('is still there when the database is opened again, and goes with its session', () => {
    const file = path.join(dir, 'kept.db');
    const first = openDatabase(file);
    const repo = new SessionsRepo(first);
    const one = inRepo(repo);
    const two = inRepo(repo);
    repo.journalStart(started(one, 'call-1'));
    repo.journalEnd(one, 'call-1', result('call-1', 'pushed'), 5);
    repo.journalStart(started(two, 'call-2', { effect: 'read', agent: 'tester: Run the tests' }));
    first.close();

    const second = openDatabase(file);
    try {
      const reopened = new SessionsRepo(second);
      expect(reopened.journalSessions().sort()).toEqual([one, two].sort());
      expect(reopened.journalOpen(one)).toMatchObject([{ toolUseId: 'call-1', endedAt: 5, result: result('call-1', 'pushed') }]);
      expect(reopened.journalOpen(two)).toMatchObject([{ toolUseId: 'call-2', endedAt: null, result: null, effect: 'read', agent: 'tester: Run the tests' }]);
      reopened.delete(two);
      expect(reopened.journalSessions()).toEqual([one]);
    } finally {
      second.close();
    }
  });

  it('is added to an installation from 0.6.16 without touching what is stored', async () => {
    const { default: Database } = await import('better-sqlite3');
    const file = path.join(dir, 'old.db');
    const old = new Database(file);
    let sessionId: string;
    try {
      old.pragma('foreign_keys = ON');
      // 0.6.16 shipped schema 8.
      migrate(old, MIGRATIONS.filter((m) => m.version <= 8));
      expect(schemaVersion(old)).toBe(8);
      const repo = new SessionsRepo(old);
      sessionId = inRepo(repo);
      repo.appendMessage(sessionId, 'user', [{ type: 'text', text: 'Keep me.' }], {});
      repo.recordUsage({ day: '2026-10-10', providerId: 'p1', modelId: 'm1', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.5 });
    } finally {
      old.close();
    }
    const upgraded = openDatabase(file);
    try {
      expect(schemaVersion(upgraded)).toBe(MIGRATIONS.at(-1)?.version);
      const repo = new SessionsRepo(upgraded);
      expect(repo.listMessages(sessionId).map((m) => m.content)).toEqual([[{ type: 'text', text: 'Keep me.' }]]);
      expect(repo.usageSince('2026-10-10')).toMatchObject([{ day: '2026-10-10', requests: 1, costUsd: 0.5 }]);
      expect(repo.journalOpen(sessionId)).toEqual([]);
    } finally {
      upgraded.close();
    }
  });
});

describe('a turn the app stopped in the middle of', () => {
  /** A conversation whose last reply asked for these calls, none of them answered. */
  function cutOff(...ids: string[]): { store: MemorySessionStore; id: string } {
    const made = inMemory();
    made.store.appendMessage(made.id, 'user', [{ type: 'text', text: 'Ship it.' }], { turnId: 'turn-1' });
    made.store.appendMessage(made.id, 'assistant', [{ type: 'text', text: 'On it.' }, ...calls(...ids)], { turnId: 'turn-1' });
    return made;
  }
  const answers = (store: SessionStore, id: string): Record<string, { text: string; isError: boolean }> =>
    Object.fromEntries(
      store.listMessages(id).flatMap((m) => m.content.flatMap((b) => (b.type === 'tool_result' ? [[b.toolUseId, { text: text(b), isError: b.isError }] as const] : [])))
    );

  it('says the outcome is unknown for a change that was running, and that it has to be checked before it is repeated', () => {
    const { store, id } = cutOff('deploy');
    store.journalStart(started(id, 'deploy', { summary: 'Run npm run deploy' }));
    const found = reconcileInterrupted(store, id);
    expect(found).toMatchObject({ unknown: [{ toolUseId: 'deploy' }], unfinished: [], recovered: [], notRun: 0 });
    expect(answers(store, id)).toEqual({ deploy: { text: OUTCOME_UNKNOWN, isError: true } });
    expect(OUTCOME_UNKNOWN).toMatch(/may have finished, stopped partway or never started/);
    expect(OUTCOME_UNKNOWN).toMatch(/check what it left behind before you repeat it/);
  });

  it('says a call that changes nothing can simply be run again', () => {
    const { store, id } = cutOff('look');
    store.journalStart(started(id, 'look', { name: 'Grep', effect: 'read' }));
    expect(reconcileInterrupted(store, id)).toMatchObject({ unknown: [], unfinished: [{ toolUseId: 'look' }] });
    expect(answers(store, id)).toEqual({ look: { text: NOT_FINISHED, isError: true } });
  });

  it('hands back what a call returned when the turn was cut before its result was stored', () => {
    const { store, id } = cutOff('push');
    store.journalStart(started(id, 'push'));
    store.journalEnd(id, 'push', { ...result('push', 'To github.com:me/repo\n  main -> main'), display: { kind: 'text', text: 'pushed' } }, 9);
    expect(reconcileInterrupted(store, id)).toMatchObject({ recovered: [{ toolUseId: 'push' }], unknown: [] });
    expect(answers(store, id)).toEqual({ push: { text: `To github.com:me/repo\n  main -> main\n${RECORDED_NOTE}`, isError: false } });
    // What the transcript showed for it is kept as well.
    expect(store.listMessages(id).at(-2)?.content[0]).toMatchObject({ display: { kind: 'text', text: 'pushed' } });
  });

  it('answers every call of the reply in its order: recorded, unknown, and never started', () => {
    const { store, id } = cutOff('one', 'two', 'three');
    store.journalStart(started(id, 'one'));
    store.journalEnd(id, 'one', result('one', 'exit 1', true), 3);
    store.journalStart(started(id, 'two'));
    const found = reconcileInterrupted(store, id);
    expect(found).toMatchObject({ recovered: [{ toolUseId: 'one' }], unknown: [{ toolUseId: 'two' }], notRun: 1 });
    const stored = store.listMessages(id).at(-2)!;
    expect(stored).toMatchObject({ role: 'user', meta: { turnId: 'turn-1' } });
    expect(stored.content.map((b) => (b.type === 'tool_result' ? b.toolUseId : ''))).toEqual(['one', 'two', 'three']);
    expect(answers(store, id)).toEqual({
      one: { text: `exit 1\n${RECORDED_NOTE}`, isError: true },
      two: { text: OUTCOME_UNKNOWN, isError: true },
      three: { text: NOT_RUN, isError: true }
    });
  });

  it('lists what an agent had finished and what it was doing, under the call that started it', () => {
    const { store, id } = cutOff('task-1');
    store.journalStart(started(id, 'task-1', { name: 'Task', summary: 'Delegated: Fix the build', effect: 'read' }));
    store.journalStart(started(id, 'a', { rootId: 'task-1', agent: 'Fix the build', name: 'Edit', summary: 'Edited src/build.ts' }));
    store.journalEnd(id, 'a', result('a', 'Edited.'), 2);
    store.journalStart(started(id, 'b', { rootId: 'task-1', agent: 'Fix the build', summary: 'Ran npm test' }));
    store.journalEnd(id, 'b', result('b', '1 failed', true), 3);
    store.journalStart(started(id, 'c', { rootId: 'task-1', agent: 'Fix the build', summary: 'Ran npm run build' }));
    expect(reconcileInterrupted(store, id)).toMatchObject({ unknown: [{ toolUseId: 'task-1' }] });
    expect(answers(store, id)['task-1']!.text).toBe(
      [
        OUTCOME_UNKNOWN,
        'What the agent it started had done by then:',
        '- finished: “Edited src/build.ts”',
        '- finished with an error: “Ran npm test”',
        '- still running, outcome unknown: “Ran npm run build”'
      ].join('\n')
    );
  });

  it('treats an agent that only looked as safe to start again', () => {
    const { store, id } = cutOff('task-1');
    store.journalStart(started(id, 'task-1', { name: 'Task', effect: 'read' }));
    store.journalStart(started(id, 'a', { rootId: 'task-1', agent: 'Look', name: 'Grep', summary: 'Search for TODO', effect: 'read' }));
    expect(reconcileInterrupted(store, id)).toMatchObject({ unknown: [], unfinished: [{ toolUseId: 'task-1' }] });
    expect(answers(store, id)['task-1']!.text).toBe(NOT_FINISHED);
  });

  it('leaves a note for the user, a conversation every provider accepts, and nothing in the journal', () => {
    const { store, id } = cutOff('deploy', 'look');
    store.journalStart(started(id, 'deploy', { summary: 'Run npm run deploy' }));
    store.journalStart(started(id, 'look', { name: 'Grep', summary: 'Search for TODO', effect: 'read' }));
    reconcileInterrupted(store, id);
    const note = store.listMessages(id).at(-1)!;
    expect(note.meta.kind).toBe('notice');
    expect(text({ type: 'tool_result', toolUseId: '', isError: false, content: note.content.flatMap((b) => (b.type === 'text' ? [b] : [])) })).toBe(
      'Graft stopped while this session was working. Outcome unknown: “Run npm run deploy”. Not finished, safe to run again: “Search for TODO”. The agent has been told, and is asked to check before it repeats anything.'
    );
    expect(store.journalOpen(id)).toEqual([]);
    // The note is for the user; the model reads the answers.
    const sent = toLlmHistory(store.listMessages(id));
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(sent.at(-1)!.content.map((b) => (b.type === 'tool_result' ? [b.toolUseId, text(b)] : []))).toEqual([['deploy', OUTCOME_UNKNOWN], ['look', NOT_FINISHED]]);
    // Said once: a second look finds nothing to do, and the conversation reads the same from then on.
    expect(reconcileInterrupted(store, id)).toBeNull();
    expect(toLlmHistory(store.listMessages(id))).toEqual(sent);
  });

  it('does nothing to a conversation whose results are stored, and clears what the journal still held', () => {
    const { store, id } = cutOff('done');
    store.appendMessage(id, 'user', [result('done', 'ok')], { turnId: 'turn-1' });
    // The app stopped between storing the result and forgetting the call.
    store.journalStart(started(id, 'done'));
    store.journalEnd(id, 'done', result('done', 'ok'), 4);
    const before = store.listMessages(id).length;
    expect(reconcileInterrupted(store, id)).toBeNull();
    expect(store.listMessages(id)).toHaveLength(before);
    expect(store.journalOpen(id)).toEqual([]);
  });

  it('says the turn ended, not that Graft stopped, when a turn failed before it stored its results', () => {
    const { store, id } = cutOff('push', 'deploy');
    store.journalStart(started(id, 'push', { summary: 'Ran git push' }));
    store.journalEnd(id, 'push', result('push', 'pushed'), 2);
    store.journalStart(started(id, 'deploy', { summary: 'Ran npm run deploy' }));
    const found = reconcileInterrupted(store, id, 'failed')!;
    expect(answers(store, id)).toEqual({
      push: { text: 'pushed\n(The turn ended right after this finished. The result above was recorded then; the turn did not go on.)', isError: false },
      deploy: { text: 'Outcome unknown: The turn ended while this was running, so it may have finished, stopped partway or never started. Do not assume either way: check what it left behind before you repeat it.', isError: true }
    });
    expect(found.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(found.messages[1]!.content)).toContain('The last turn ended before its results were stored. Outcome unknown: “Ran npm run deploy”. Finished before the stop, result kept: “Ran git push”.');
  });

  it('leaves a turn that was cut before anything started to the usual repair', () => {
    const { store, id } = cutOff('never');
    expect(reconcileInterrupted(store, id)).toBeNull();
    expect(text(toLlmHistory(store.listMessages(id)).at(-1)!.content[0])).toBe(NOT_RUN);
  });
});
