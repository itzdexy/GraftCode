import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_CACHED_VIEWS, mergeAgentRuns, useSessions, viewOf } from '../../../src/renderer/src/stores/sessions';
import type { Mission } from '../../../src/shared/schemas/missions';
import type { SessionDetail, SessionSummary } from '../../../src/shared/schemas/sessions';
import type { StoredMessage } from '../../../src/shared/schemas/messages';
import type { PermissionRequest } from '../../../src/shared/schemas/permissions';
import { invoke } from '../../../src/renderer/src/lib/ipc';
import { makeAgentRun } from './agentRun';

vi.mock('../../../src/renderer/src/lib/ipc', async (original) => ({ ...await original<object>(), invoke: vi.fn() }));

const shown = (): Array<[string, string]> => viewOf(useSessions.getState(), 's').agentRuns.map((r) => [r.nodeId, r.status]);

describe('agents in the session view', () => {
  beforeEach(() => {
    useSessions.setState({ summaries: {}, views: { s: viewOf({ views: {} }, 's') }, viewOrder: ['s'] });
  });

  it('adds an agent when it is first heard of, and replaces it as it changes', () => {
    const { applyEvent } = useSessions.getState();
    applyEvent('s', { type: 'agent-run', run: makeAgentRun('a', [], { status: 'queued', rev: 0 }) });
    applyEvent('s', { type: 'agent-run', run: makeAgentRun('b', ['a'], { status: 'queued', rev: 0 }) });
    applyEvent('s', { type: 'agent-run', run: makeAgentRun('a', [], { status: 'running', rev: 1 }) });
    expect(shown()).toEqual([
      ['a', 'running'],
      ['b', 'queued']
    ]);
  });

  it('keeps what it has when an older change arrives late', () => {
    const { applyEvent } = useSessions.getState();
    applyEvent('s', { type: 'agent-run', run: makeAgentRun('a', [], { status: 'done', rev: 7 }) });
    applyEvent('s', { type: 'agent-run', run: makeAgentRun('a', [], { status: 'running', rev: 3 }) });
    expect(shown()).toEqual([['a', 'done']]);
  });

  it('ignores agents of a session that is not open', () => {
    useSessions.getState().applyEvent('other', { type: 'agent-run', run: makeAgentRun('a') });
    expect(useSessions.getState().views.other).toBeUndefined();
  });

  it('joins a loaded session with what was heard while it loaded: the later record of each agent wins', () => {
    const loaded = [makeAgentRun('a', [], { status: 'running', rev: 3 }), makeAgentRun('b', [], { status: 'queued', rev: 1 })];
    const heard = [makeAgentRun('a', [], { status: 'done', rev: 5 }), makeAgentRun('b', [], { status: 'queued', rev: 0 }), makeAgentRun('c', [], { status: 'queued', rev: 0 })];
    expect(mergeAgentRuns(loaded, heard).map((r) => [r.nodeId, r.status, r.rev])).toEqual([
      ['a', 'done', 5],
      ['b', 'queued', 1],
      ['c', 'queued', 0]
    ]);
    // Nothing heard: the loaded list as it is.
    expect(mergeAgentRuns(loaded, [])).toBe(loaded);
  });
});

function summary(extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's', kind: 'chat', title: 'Before', status: 'idle', pinned: false, archived: false, unread: false, incognito: false,
    projectId: null, projectPath: null, projectName: null, cwd: null, worktreePath: null, branch: null, baseBranch: null,
    model: null, effort: null, permissionMode: 'ask', lastError: null,
    usage: { totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, contextTokens: 0, contextLimit: 0, costUsd: null },
    createdAt: 1, updatedAt: 1, ...extra
  };
}

function message(seq: number, extra: Partial<StoredMessage> = {}): StoredMessage {
  return { id: `m${seq}`, sessionId: 's', seq, role: 'assistant', content: [{ type: 'text', text: 'Reply' }], meta: {}, createdAt: seq, ...extra };
}

function detail(extra: Partial<SessionDetail> = {}): SessionDetail {
  return { summary: summary(), messages: [], todos: [], queue: [], agentRuns: [], mission: null, pendingPermission: null, pendingQuestion: null, ...extra };
}

function deferredDetail() {
  let resolve!: (value: SessionDetail) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<SessionDetail>((yes, no) => { resolve = yes; reject = no; });
  vi.mocked(invoke).mockReturnValueOnce(promise);
  return { resolve, reject };
}

describe('session detail requests and live events', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useSessions.setState({ summaries: { s: summary() }, views: {}, viewOrder: [] });
  });
  const current = () => viewOf(useSessions.getState(), 's');

  it('keeps same-ID message edits and newly committed messages heard during a load', async () => {
    const request = deferredDetail();
    const opening = useSessions.getState().open('s');
    const updated = message(1, { meta: { feedback: 1, compacted: true } });
    useSessions.getState().applyEvent('s', { type: 'message', message: updated });
    useSessions.getState().applyEvent('s', { type: 'message', message: message(2) });
    request.resolve(detail({ messages: [message(1)] }));
    await opening;
    expect(current().messages).toEqual([updated, message(2)]);
  });

  it('lets the snapshot replace cached messages, agents and missions from before the request', async () => {
    useSessions.setState({ views: { s: { ...current(), messages: [message(1), message(2)], agentRuns: [makeAgentRun('gone')], mission: mission() } } });
    const request = deferredDetail();
    const opening = useSessions.getState().open('s');
    request.resolve(detail({ messages: [message(1)] }));
    await opening;
    expect(current()).toMatchObject({ messages: [message(1)], agentRuns: [], mission: null });
  });

  it('ignores the pre-rewind request when it finishes after a reset reload', async () => {
    const before = deferredDetail();
    const first = useSessions.getState().open('s');
    const after = deferredDetail();
    const reset = useSessions.getState().open('s', { reset: true });
    after.resolve(detail({ messages: [message(1)], summary: summary({ title: 'Rewound' }) }));
    await reset;
    before.resolve(detail({ messages: [message(1), message(2)], summary: summary({ title: 'Before rewind' }) }));
    await first;
    expect(current().messages).toEqual([message(1)]);
    expect(useSessions.getState().summaries.s?.title).toBe('Rewound');
  });

  it('does not let an older failed request clear a newer request loading state', async () => {
    const before = deferredDetail();
    const first = useSessions.getState().open('s');
    const after = deferredDetail();
    const second = useSessions.getState().open('s');
    before.reject(new Error('Old failure'));
    await first;
    expect(current()).toMatchObject({ loading: true, error: null });
    after.resolve(detail());
    await second;
    expect(current()).toMatchObject({ loading: false, error: null });
  });

  it('cannot restore a session removed while its request was pending', async () => {
    const request = deferredDetail();
    const opening = useSessions.getState().open('s');
    useSessions.getState().remove('s');
    request.resolve(detail({ messages: [message(1)] }));
    await opening;
    expect(useSessions.getState().views.s).toBeUndefined();
    expect(useSessions.getState().summaries.s).toBeUndefined();
  });

  it('cannot restore an evicted request over a later reopened view', async () => {
    const firstRequest = deferredDetail();
    const first = useSessions.getState().open('s');
    for (let i = 0; i < MAX_CACHED_VIEWS; i++) {
      vi.mocked(invoke).mockResolvedValueOnce(detail({ summary: summary({ id: `other-${i}` }) }));
      await useSessions.getState().open(`other-${i}`);
    }
    expect(useSessions.getState().views.s).toBeUndefined();
    const newRequest = deferredDetail();
    const reopened = useSessions.getState().open('s');
    newRequest.resolve(detail({ messages: [message(1)] }));
    await reopened;
    firstRequest.resolve(detail({ messages: [message(1), message(2)] }));
    await first;
    expect(current().messages).toEqual([message(1)]);
  });

  it('keeps resolved prompts, an emptied queue and removed mission even before the initial snapshot arrives', async () => {
    const permission: PermissionRequest = {
      id: 'p', sessionId: 's', toolUseId: 'tool', toolName: 'Shell', title: 'Run it', detail: { kind: 'generic', text: 'Run' },
      reason: 'Required', dangerous: null, outsideProject: false, suggestedRule: null, agentLabel: null
    };
    const question = { id: 'q', sessionId: 's', toolUseId: 'tool', questions: [{ question: 'Which?', options: [], multiSelect: false }] };
    const request = deferredDetail();
    const opening = useSessions.getState().open('s');
    useSessions.getState().applyEvent('s', { type: 'permission-resolved', requestId: 'p' });
    useSessions.getState().applyEvent('s', { type: 'question-resolved', requestId: 'q' });
    useSessions.getState().applyEvent('s', { type: 'queue', queue: [] });
    useSessions.getState().applyEvent('s', { type: 'mission', mission: null });
    request.resolve(detail({
      pendingPermission: permission, pendingQuestion: question, mission: mission(),
      queue: [{ id: 'queued', text: 'Next', attachmentCount: 0, createdAt: 1, steer: false }]
    }));
    await opening;
    expect(current()).toMatchObject({ permission: null, question: null, queue: [], mission: null });
  });

  it('preserves events for new prompts and todo updates during loading', async () => {
    const request = deferredDetail();
    const opening = useSessions.getState().open('s');
    const question = { id: 'new', sessionId: 's', toolUseId: 'tool', questions: [{ question: 'Which?', options: [], multiSelect: false }] };
    const todos = [{ id: 'todo', content: 'Finish', status: 'completed' as const }];
    useSessions.getState().applyEvent('s', { type: 'question', request: question });
    useSessions.getState().applyEvent('s', { type: 'question-resolved', requestId: 'old' });
    useSessions.getState().applyEvent('s', { type: 'todos', todos });
    request.resolve(detail());
    await opening;
    expect(current()).toMatchObject({ question, todos });
  });

  it('preserves summary updates in arrival order and a turn ending during loading', async () => {
    const request = deferredDetail();
    const opening = useSessions.getState().open('s');
    useSessions.getState().applyEvent('s', { type: 'status', status: 'running', error: null });
    useSessions.getState().applySummary(summary({ title: 'Renamed', status: 'needs-input' }));
    useSessions.getState().applyEvent('s', { type: 'status', status: 'idle', error: null });
    useSessions.getState().applyEvent('s', { type: 'turn-end', turnId: 'turn', reason: 'completed' });
    request.resolve(detail({ summary: summary({ status: 'running' }) }));
    await opening;
    expect(useSessions.getState().summaries.s).toMatchObject({ title: 'Renamed', status: 'idle' });
    expect(current()).toMatchObject({ turnActive: false, turnStartedAt: null });
  });

  it('retains the greatest agent revision instead of replaying a stale event', async () => {
    const request = deferredDetail();
    const opening = useSessions.getState().open('s');
    useSessions.getState().applyEvent('s', { type: 'agent-run', run: makeAgentRun('a', [], { rev: 5 }) });
    useSessions.getState().applyEvent('s', { type: 'agent-run', run: makeAgentRun('a', [], { rev: 2 }) });
    request.resolve(detail({ agentRuns: [makeAgentRun('a', [], { rev: 3 })] }));
    await opening;
    expect(current().agentRuns[0]?.rev).toBe(5);
  });

  it('bounds a stalled request overlay and keeps live messages when it exceeds the bound', async () => {
    const request = deferredDetail();
    const opening = useSessions.getState().open('s');
    for (let seq = 1; seq <= 513; seq++) useSessions.getState().applyEvent('s', { type: 'message', message: message(seq) });
    expect(current().loading).toBe(false);
    expect(current().error).toContain('Reopen');
    request.resolve(detail());
    await opening;
    expect(current().messages).toHaveLength(513);
  });
});

function mission(extra: Partial<Mission> = {}): Mission {
  return {
    id: 'm1',
    sessionId: 's',
    objective: 'Ship it',
    criteria: [],
    checks: [],
    status: 'active',
    reason: null,
    turns: 1,
    maxTurns: 10,
    claimed: false,
    result: '',
    notebook: [],
    verification: null,
    createdAt: 1,
    updatedAt: 1,
    endedAt: null,
    rev: 0,
    ...extra
  };
}

describe('the mission in the session view', () => {
  beforeEach(() => {
    useSessions.setState({ summaries: {}, views: { s: viewOf({ views: {} }, 's') }, viewOrder: ['s'] });
  });
  const shown = (): Mission | null => viewOf(useSessions.getState(), 's').mission;

  it('follows the mission as it changes, and keeps the later state when two changes arrive out of order', () => {
    const { applyEvent } = useSessions.getState();
    applyEvent('s', { type: 'mission', mission: mission({ rev: 0 }) });
    applyEvent('s', { type: 'mission', mission: mission({ rev: 4, status: 'paused', reason: 'You paused it.' }) });
    applyEvent('s', { type: 'mission', mission: mission({ rev: 2, turns: 2 }) });
    expect(shown()).toMatchObject({ rev: 4, status: 'paused' });
  });

  it('takes a new mission whatever its count, and loses the mission when a rewind removes it', () => {
    const { applyEvent } = useSessions.getState();
    applyEvent('s', { type: 'mission', mission: mission({ rev: 9, status: 'done' }) });
    applyEvent('s', { type: 'mission', mission: mission({ id: 'm2', rev: 0, objective: 'Next' }) });
    expect(shown()).toMatchObject({ id: 'm2', objective: 'Next' });
    applyEvent('s', { type: 'mission', mission: null });
    expect(shown()).toBeNull();
  });
});
