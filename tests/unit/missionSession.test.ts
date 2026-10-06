import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/shared/schemas/agentEvents';
import { textOf } from '../../src/shared/schemas/messages';
import type { Mission } from '../../src/shared/schemas/missions';
import { ProviderError } from '../../src/main/providers/errors';
import type { StreamRequest } from '../../src/main/providers/types';
import type { FakeFailure, FakeReply, FakeStep } from '../support/fakeProvider';
import { makeHarness, type Harness, type HarnessOptions } from '../support/sessionHarness';

type Answer = FakeReply | FakeFailure;

/** What the model was last sent by the user side: the text of the newest user message. */
function lastUserText(request: StreamRequest): string {
  const last = request.messages.findLast((m) => m.role === 'user');
  return last ? last.content.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? textOf(b.content) : '')).join('\n') : '';
}

/** True when the model is being handed a tool result: it is in the middle of a turn. */
function afterTool(request: StreamRequest): boolean {
  return request.messages.at(-1)?.content.some((b) => b.type === 'tool_result') ?? false;
}

/**
 * A scripted model for a mission: `turn` answers the first request of each
 * turn (it gets the turn's number and what the turn was started with); after a
 * tool call the model just ends its turn.
 */
function script(turn: (n: number, text: string, request: StreamRequest) => Answer, steps = 40): FakeStep[] {
  let n = 0;
  const step: FakeStep = (request) => (afterTool(request) ? { text: 'Ending the turn.' } : turn(++n, lastUserText(request), request));
  return Array.from({ length: steps }, () => step);
}

function start(turn: Parameters<typeof script>[0], options: Partial<HarnessOptions> = {}): Harness {
  return makeHarness({ mode: 'bypass', bypassEnabled: true, ...options, script: script(turn) });
}

const mission = (h: Harness): Mission | null => h.store.getMission('session-1');
const update = (input: object): Answer => ({ toolCalls: [{ name: 'MissionUpdate', input }] });
const PASS = 'node -e "process.exit(0)"';
/** Passes once ok.txt exists in the project folder. */
const NEEDS_FILE = `node -e "process.exit(require('fs').existsSync('ok.txt') ? 0 : 1)"`;

const kinds = (h: Harness): string[] => h.store.listMessages('session-1').map((m) => `${m.role}:${m.meta.kind ?? 'normal'}`);
const missionEvents = (h: Harness): Mission[] => h.events.filter((e): e is Extract<AgentEvent, { type: 'mission' }> => e.type === 'mission').flatMap((e) => (e.mission ? [e.mission] : []));

describe('a mission in a session', () => {
  it('keeps the agent going turn after turn, runs the checks when it reports done, and ends when they pass', async () => {
    const seen: string[] = [];
    const h = start((n, text) => {
      seen.push(text);
      if (n === 1) return { text: 'I looked around.' };
      if (n === 2) return update({ note: { kind: 'decision', text: 'Use a token bucket.' } });
      return update({ status: 'done', summary: 'The limiter is in and tested.' });
    });
    expect(h.session.startMission({ objective: 'Add rate limiting', criteria: ['Returns 429 past the limit'], checks: [PASS], maxTurns: 10 })).toEqual({ queued: false });
    await h.session.idle();

    expect(mission(h)).toMatchObject({ status: 'done', turns: 3, result: 'The limiter is in and tested.', verification: { passed: true } });
    expect(mission(h)!.notebook.map((n) => n.text)).toEqual(['Use a token bucket.']);
    // Turn 1 got the brief; turns 2 and 3 got the mission again, with the notebook once there was one.
    expect(seen[0]).toContain('Add rate limiting');
    expect(seen[0]).toContain('This is a mission');
    expect(seen[1]).toContain('[Mission, turn 2 of 10]');
    expect(seen[2]).toContain('[Mission, turn 3 of 10]');
    expect(seen[2]).toContain('Use a token bucket.');
    // The transcript shows the objective as what the user wrote, and the checks that decided it.
    const first = h.store.listMessages('session-1')[0]!;
    expect(first.meta.typed).toBe('Add rate limiting');
    expect(kinds(h).filter((k) => k === 'user:mission')).toHaveLength(2);
    expect(kinds(h).at(-1)).toBe('user:check');
    expect(h.store.listMessages('session-1').at(-1)!.meta.check).toMatchObject({ passed: true });
    expect(h.session.liveSummary().status).toBe('idle');
    expect(h.notifications.at(-1)).toMatchObject({ kind: 'finished' });
    expect(h.notifications.at(-1)!.text).toMatch(/mission/i);
    // The interface heard every change, each newer than the last.
    const revs = missionEvents(h).map((m) => m.rev);
    expect(revs).toEqual([...revs].sort((a, b) => a - b));
    expect(missionEvents(h).at(-1)).toMatchObject({ status: 'done' });
    expect(h.session.detail().mission).toMatchObject({ status: 'done' });
  });

  it('does not take the agent’s word for it: a failed check goes back, and the mission ends only once it passes', async () => {
    const seen: string[] = [];
    let wrote = false;
    const h = start((n, text) => {
      seen.push(text);
      if (n === 1) return update({ status: 'done', summary: 'Done, I think.' });
      if (!wrote) {
        wrote = true;
        return { toolCalls: [{ name: 'Write', input: { file_path: 'ok.txt', content: 'ok\n' } }] };
      }
      return update({ status: 'done', summary: 'Done for real.' });
    });
    h.session.startMission({ objective: 'Make the check pass', criteria: [], checks: [NEEDS_FILE], maxTurns: 10 });
    await h.session.idle();

    expect(fs.existsSync(path.join(h.projectDir, 'ok.txt'))).toBe(true);
    expect(mission(h)).toMatchObject({ status: 'done', result: 'Done for real.', verification: { passed: true } });
    expect(seen[1]).toMatch(/checks do not pass/);
    // Two runs of the checks are in the transcript: the one that failed and the one that passed.
    const checks = h.store.listMessages('session-1').flatMap((m) => (m.meta.check ? [m.meta.check.passed] : []));
    expect(checks).toEqual([false, true]);
  });

  it('pauses when it has used its turns, and goes on with more when resumed', async () => {
    let done = false;
    const h = start(() => (done ? update({ status: 'done', summary: 'Finished after all.' }) : { text: 'Still working.' }));
    h.session.startMission({ objective: 'A long job', criteria: [], checks: [], maxTurns: 2 });
    await h.session.idle();
    expect(mission(h)).toMatchObject({ status: 'paused', turns: 2 });
    expect(mission(h)!.reason).toMatch(/2 turns/);
    expect(h.provider.requests).toHaveLength(2);
    expect(h.notifications.at(-1)).toMatchObject({ kind: 'needs-input' });

    done = true;
    h.session.resumeMission();
    await h.session.idle();
    expect(mission(h)).toMatchObject({ status: 'done', turns: 3, result: 'Finished after all.' });
  });

  it('pauses when the user stops a turn, and does not start another on its own', async () => {
    const h = start(() => ({ text: 'word '.repeat(200), chunkDelayMs: 20 }));
    h.session.startMission({ objective: 'Something slow', criteria: [], checks: [], maxTurns: 10 });
    await h.waitFor((e) => e.type === 'assistant-delta');
    h.session.interrupt();
    await h.session.idle();
    expect(mission(h)).toMatchObject({ status: 'paused', reason: 'You stopped it.', turns: 1 });
    expect(h.provider.requests).toHaveLength(1);
  });

  it('lets a turn finish when paused, then waits', async () => {
    const h = start(() => ({ text: 'word '.repeat(20), chunkDelayMs: 10 }));
    h.session.startMission({ objective: 'Pause me', criteria: [], checks: [], maxTurns: 10 });
    await h.waitFor((e) => e.type === 'assistant-delta');
    h.session.pauseMission();
    await h.session.idle();
    expect(mission(h)).toMatchObject({ status: 'paused', reason: 'You paused it.' });
    // The turn was not cut off: its reply is whole.
    const reply = h.store.listMessages('session-1').findLast((m) => m.role === 'assistant')!;
    expect(reply.meta.interrupted).toBeUndefined();
    expect(textOf(reply.content)).toBe('word '.repeat(20));
    expect(h.provider.requests).toHaveLength(1);
  });

  it('pauses and asks for the user when the agent is blocked', async () => {
    const h = start(() => update({ status: 'blocked', summary: 'I need the staging API key.' }));
    h.session.startMission({ objective: 'Deploy to staging', criteria: [], checks: [], maxTurns: 10 });
    await h.session.idle();
    expect(mission(h)).toMatchObject({ status: 'paused', reason: 'Blocked: I need the staging API key.' });
    expect(h.notifications.some((n) => n.kind === 'needs-input' && n.text.includes('staging API key'))).toBe(true);
    // One turn only (the call and the turn's closing reply).
    expect(h.provider.requests).toHaveLength(2);
  });

  it('answers a message the user sends meanwhile, then goes on with the mission', async () => {
    const seen: string[] = [];
    const h = start((n, text) => {
      seen.push(text);
      if (n === 1) return { text: 'word '.repeat(10), chunkDelayMs: 10 };
      if (n === 2) return { text: 'Redis it is.' };
      return update({ status: 'done', summary: 'Done with Redis.' });
    });
    h.session.startMission({ objective: 'Add caching', criteria: [], checks: [], maxTurns: 10 });
    await h.waitFor((e) => e.type === 'assistant-delta');
    expect(h.session.send('Use Redis for it.')).toEqual({ queued: true });
    await h.session.idle();
    expect(seen[1]).toBe('Use Redis for it.');
    expect(seen[2]).toContain('[Mission, turn 2 of 10]');
    expect(mission(h)).toMatchObject({ status: 'done', turns: 2 });
  });

  it('offers the mission tool only while a mission is open', async () => {
    const tools: string[][] = [];
    const h = start((n, _text, request) => {
      tools.push(request.tools.map((t) => t.name));
      return n === 1 ? { text: 'Hello.' } : n === 2 ? update({ status: 'done', summary: 'Done.' }) : { text: 'Anything else?' };
    });
    h.session.send('Just a question.');
    await h.session.idle();
    h.session.startMission({ objective: 'Do the thing', criteria: [], checks: [], maxTurns: 5 });
    await h.session.idle();
    h.session.send('Thanks.');
    await h.session.idle();
    expect(tools[0]).not.toContain('MissionUpdate');
    expect(tools[1]).toContain('MissionUpdate');
    expect(tools[2]).not.toContain('MissionUpdate');
  });

  it('stops for good when cancelled', async () => {
    const h = start(() => ({ text: 'word '.repeat(200), chunkDelayMs: 20 }));
    h.session.startMission({ objective: 'Never mind', criteria: [], checks: [], maxTurns: 10 });
    await h.waitFor((e) => e.type === 'assistant-delta');
    h.session.cancelMission();
    await h.session.idle();
    expect(mission(h)).toMatchObject({ status: 'cancelled' });
    expect(h.provider.requests).toHaveLength(1);
    expect(() => h.session.resumeMission()).toThrow(/no paused mission/i);
  });

  it('allows one mission at a time, in code sessions only', async () => {
    const h = start(() => update({ status: 'blocked', summary: 'Waiting.' }));
    h.session.startMission({ objective: 'First', criteria: [], checks: [], maxTurns: 5 });
    await h.session.idle();
    expect(() => h.session.startMission({ objective: 'Second', criteria: [], checks: [], maxTurns: 5 })).toThrow(/already has a mission/);
    const chat = makeHarness({ kind: 'chat', script: [] });
    expect(() => chat.session.startMission({ objective: 'In a chat', criteria: [], checks: [], maxTurns: 5 })).toThrow(/code sessions/);
  });

  it('goes away with its turn when the session is rewound to before it', async () => {
    const h = start(() => update({ status: 'blocked', summary: 'Waiting.' }));
    h.session.send('Before the mission.');
    await h.session.idle();
    h.session.startMission({ objective: 'To be rewound', criteria: [], checks: [], maxTurns: 5 });
    await h.session.idle();
    expect(mission(h)).not.toBeNull();
    const missionMessage = h.store.listMessages('session-1').find((m) => m.meta.typed === 'To be rewound')!;
    h.session.truncateFrom(missionMessage.seq);
    expect(mission(h)).toBeNull();
    expect(h.session.detail().mission).toBeNull();
  });

  it('pauses when a turn fails, saying why', async () => {
    const h = makeHarness({
      mode: 'bypass',
      bypassEnabled: true,
      script: [{ error: new ProviderError('auth', 'The key was rejected.') }]
    });
    h.session.startMission({ objective: 'Will fail', criteria: [], checks: [], maxTurns: 5 });
    await h.session.idle();
    expect(mission(h)).toMatchObject({ status: 'paused' });
    expect(mission(h)!.reason).toMatch(/^A turn failed: /);
  });
});
