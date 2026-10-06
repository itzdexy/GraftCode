import { beforeEach, describe, expect, it } from 'vitest';
import { mergeAgentRuns, useSessions, viewOf } from '../../../src/renderer/src/stores/sessions';
import type { Mission } from '../../../src/shared/schemas/missions';
import { makeAgentRun } from './agentRun';

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
