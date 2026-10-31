import { describe, expect, it } from 'vitest';
import type { Attempt, AttemptSet } from '../../../src/shared/schemas/attempts';
import { EMPTY_USAGE } from '../../../src/shared/schemas/common';
import type { StoredMessage } from '../../../src/shared/schemas/messages';
import { attemptModels, attemptsUnavailable } from '../../../src/renderer/src/features/composer/attemptsChoice';
import type { BranchState } from '../../../src/renderer/src/features/home/ContextChips';
import { attemptRows, attemptsHeadline, sharedNotes } from '../../../src/renderer/src/features/session/attemptsModel';
import { buildTranscript } from '../../../src/renderer/src/features/session/transcriptModel';

const attempt = (index: number, over: Partial<Attempt> = {}): Attempt => ({
  index,
  model: { providerId: 'p', modelId: `m${String(index)}`, label: `Model ${String(index)}` },
  status: 'candidate',
  error: null,
  workspaceId: `w${String(index)}`,
  activity: null,
  files: [{ path: 'a.ts', added: 3, removed: 1, binary: false }],
  checks: { passed: true, runs: [{ command: 'npm test', exitCode: 0, output: '', truncated: false, durationMs: 900, timedOut: false, passed: true }], round: 1 },
  notes: [],
  usage: { ...EMPTY_USAGE, inputTokens: 1_000, outputTokens: 200 },
  costUsd: 0.0042,
  startedAt: 1_000,
  endedAt: 5_200,
  report: 'Changed a.ts.',
  ...over
});

const set = (over: Partial<AttemptSet> = {}): AttemptSet => ({
  id: 'set-1',
  messageId: 'm-1',
  status: 'open',
  applied: null,
  note: null,
  attempts: [attempt(1), attempt(2)],
  createdAt: 0,
  ...over
});

describe('the attempts card', () => {
  it('shows what each finished attempt changed, how its checks went, what it used and how long it took', () => {
    const failing = attempt(2, {
      files: [
        { path: 'a.ts', added: 1, removed: 0, binary: false },
        { path: 'logo.png', added: 0, removed: 0, binary: true }
      ],
      checks: {
        passed: false,
        runs: [
          { command: 'npm run lint', exitCode: 0, output: '', truncated: false, durationMs: 10, timedOut: false, passed: true },
          { command: 'npm test', exitCode: 1, output: 'FAIL', truncated: false, durationMs: 10, timedOut: false, passed: false }
        ],
        round: 1
      },
      costUsd: null
    });
    const [first, second] = attemptRows(set({ attempts: [attempt(1), failing] }), 10_000);
    expect(first).toMatchObject({
      index: 1,
      model: 'Model 1',
      state: 'Done',
      files: { count: 1, added: 3, removed: 1 },
      checks: { label: 'Check passed', failed: false },
      tokens: 1_200,
      cost: '$0.004',
      time: '4.2 s',
      canDiff: true,
      canApply: true,
      canStop: false
    });
    expect(second).toMatchObject({ files: { count: 2, added: 1, removed: 0 }, checks: { label: '1 of 2 checks failed', failed: true }, cost: 'No published price' });
    expect(attemptsHeadline(set())).toBe('2 attempts · 2 ready to compare');
  });

  it('while they run: the time goes on, a running one can be stopped, and nothing can be applied yet', () => {
    const running = set({
      status: 'running',
      attempts: [attempt(1, { status: 'running', activity: 'Edit a.ts', files: [], checks: null, endedAt: null, report: '' }), attempt(2), attempt(3, { status: 'queued', startedAt: null, endedAt: null, files: [], checks: null, usage: EMPTY_USAGE, costUsd: null })]
    });
    const [one, two, three] = attemptRows(running, 7_000);
    expect(one).toMatchObject({ state: 'Running', activity: 'Edit a.ts', time: '6.0 s', canStop: true, canApply: false, canDiff: false, checks: null });
    expect(two).toMatchObject({ state: 'Done', canStop: false, canApply: false });
    expect(three).toMatchObject({ state: 'Waiting', time: null, cost: null, tokens: 0, canStop: true });
    expect(attemptsHeadline(running)).toBe('3 attempts · 2 working, 1 done');
  });

  it('after one was applied, only it keeps its diff; failed, stopped and empty ones never offer Apply', () => {
    const applied = set({ status: 'applied', applied: 2 });
    expect(attemptRows(applied, 0).map((r) => [r.state, r.canDiff, r.canApply])).toEqual([
      ['Done', false, false],
      ['Applied', true, false]
    ]);
    expect(attemptsHeadline(applied)).toBe('Applied attempt 2 of 2');
    const mixed = set({ attempts: [attempt(1, { status: 'failed', error: 'The model request failed.' }), attempt(2, { status: 'stopped', error: 'Stopped.' }), attempt(3, { files: [] })] });
    expect(attemptRows(mixed, 0).map((r) => [r.state, r.tone, r.canApply])).toEqual([
      ['Failed', 'danger', false],
      ['Stopped', 'warning', false],
      ['Done', 'neutral', false]
    ]);
    expect(attemptsHeadline(set({ status: 'discarded' }))).toBe('2 attempts, discarded');
    expect(attemptsHeadline(set({ attempts: [attempt(1, { status: 'failed' }), attempt(2, { status: 'stopped' })] }))).toBe('2 attempts · none finished');
  });

  it('says a note every attempt has once, on the card, and keeps the others on their rows', () => {
    const none = 'No checks ran: this project has none set up. Add them in Customize → Checks.';
    const ignored = 'Its edits to ignored files are not part of it: .env.';
    const noted = set({ attempts: [attempt(1, { notes: [none, ignored] }), attempt(2, { notes: [none] })] });
    expect(sharedNotes(noted)).toEqual([none]);
    expect(attemptRows(noted, 0).map((r) => r.notes)).toEqual([[ignored], []]);
    expect(sharedNotes(set())).toEqual([]);
  });

  it('is drawn from the notice that holds it, in place of its text', () => {
    const card: StoredMessage = { id: 'set-1', sessionId: 's', seq: 2, role: 'assistant', content: [{ type: 'text', text: 'Sent as 2 attempts.' }], meta: { kind: 'notice', attempts: set() }, createdAt: 2 };
    const sent: StoredMessage = { id: 'm-1', sessionId: 's', seq: 1, role: 'user', content: [{ type: 'text', text: 'Fix it' }], meta: {}, createdAt: 1 };
    const items = buildTranscript([sent, card], { streaming: null, running: {} });
    expect(items.map((i) => i.kind)).toEqual(['user', 'attempts']);
  });
});

describe('the attempts control of a message box', () => {
  it('stays off where attempts cannot work, and says why', () => {
    const repo: BranchState = { status: 'ready', list: { isRepo: true, current: 'main', branches: [] } };
    expect(attemptsUnavailable('/p', repo, 'auto-edit')).toBeNull();
    expect(attemptsUnavailable('/p', { status: 'loading' }, 'ask')).toBeNull();
    expect(attemptsUnavailable(null, { status: 'none' }, 'ask')).toBe('Attempts work in a session with a project folder.');
    expect(attemptsUnavailable('/p', { status: 'ready', list: { isRepo: false, current: null, branches: [] } }, 'ask')).toBe('Attempts need the folder to be a Git repository.');
    expect(attemptsUnavailable('/p', repo, 'plan')).toBe('Attempts change files, so they are off in Plan mode.');
  });


  it("sends each attempt on its picked model, the session's where none was picked, and goes once below two", () => {
    const session = { providerId: 'p', modelId: 'own' };
    const other = { providerId: 'q', modelId: 'other' };
    expect(attemptModels({ count: 3, models: [null, other] }, session)).toEqual([session, other, session]);
    expect(attemptModels({ count: 1, models: [other] }, session)).toBeNull();
    expect(attemptModels(undefined, session)).toBeNull();
    expect(attemptModels({ count: 2, models: [] }, null)).toBeNull();
  });
});
