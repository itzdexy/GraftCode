import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/shared/schemas/agentEvents';
import { makeHarness, type Harness } from '../support/sessionHarness';

/**
 * A turn of a code session starts from a snapshot of its folder, for Rewind.
 * A folder too large to snapshot quickly (a whole Downloads folder) used to
 * keep the message unseen, the turn unstoppable and the session undeletable.
 */

let open: Harness[] = [];
afterEach(async () => {
  for (const h of open) await h.session.dispose();
  open = [];
});

const userMessages = (events: AgentEvent[]) => events.filter((e): e is Extract<AgentEvent, { type: 'message' }> => e.type === 'message' && e.message.role === 'user');
const notices = (events: AgentEvent[]) => events.filter((e): e is Extract<AgentEvent, { type: 'notice' }> => e.type === 'notice').map((e) => e.text);

/** A snapshot that takes as long as it is let: it ends only when its signal says so. */
function endless(seen: { signal: AbortSignal | null }) {
  return (_session: string, _cwd: string, _message: string, signal?: AbortSignal): Promise<string | null> =>
    new Promise((_resolve, reject) => {
      seen.signal = signal ?? null;
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
}

describe('the snapshot a turn starts from', () => {
  it('is taken after the message is shown, and is named on it once taken', async () => {
    let release: (id: string) => void = () => undefined;
    const h = makeHarness({ script: [{ text: 'Done.' }], checkpoint: () => new Promise((resolve) => (release = resolve)) });
    open.push(h);
    h.session.send('Rename the helper');
    const shown = await h.waitFor((e) => e.type === 'message' && e.message.role === 'user');
    expect(shown.type === 'message' && shown.message.meta.typed).toBe('Rename the helper');
    // Nothing has been asked of the model while the snapshot runs.
    expect(h.provider.requests).toHaveLength(0);
    release('checkpoint-1');
    await h.session.idle();
    const versions = userMessages(h.events);
    expect(versions.at(-1)?.message.meta.checkpointId).toBe('checkpoint-1');
    expect(versions.every((e) => e.message.id === versions[0]?.message.id)).toBe(true);
    expect(h.provider.requests).toHaveLength(1);
  });

  it('is given up when it runs past its time, with a notice, and not tried again in that folder', async () => {
    const seen = { signal: null as AbortSignal | null };
    let calls = 0;
    const slow = endless(seen);
    const h = makeHarness({
      script: [{ text: 'First answer.' }, { text: 'Second answer.' }],
      checkpoint: (...args) => {
        calls += 1;
        return slow(...args);
      },
      timings: { checkpointMs: 60 }
    });
    open.push(h);
    await h.turn('Look at the folder');
    expect(seen.signal?.aborted).toBe(true);
    expect(notices(h.events).some((text) => /^No checkpoint for this turn: .+ took longer than 0 seconds to snapshot/.test(text))).toBe(true);
    // The turn went on without one.
    expect(h.provider.requests).toHaveLength(1);
    await h.turn('And again');
    expect(calls).toBe(1);
    expect(h.provider.requests).toHaveLength(2);
    expect(notices(h.events).filter((text) => text.includes('No checkpoint'))).toHaveLength(1);
  });

  it('ends at once when the turn is stopped, and the turn ends with it', async () => {
    const seen = { signal: null as AbortSignal | null };
    const h = makeHarness({ script: [{ text: 'Never asked.' }], checkpoint: endless(seen) });
    open.push(h);
    h.session.send('Start something');
    await h.waitFor((e) => e.type === 'message' && e.message.role === 'user');
    h.session.interrupt();
    const end = await h.waitFor((e) => e.type === 'turn-end');
    expect(end.type === 'turn-end' && end.reason).toBe('interrupted');
    expect(seen.signal?.aborted).toBe(true);
    expect(h.provider.requests).toHaveLength(0);
    // The message says it was stopped, rather than sitting there unanswered.
    expect(h.store.listMessages(h.session.id).map((m) => `${m.role}:${m.meta.kind ?? 'normal'}`)).toEqual(['user:normal', 'assistant:notice']);
  });

  it('never keeps a session from closing, even when the snapshot does not hear the stop', async () => {
    const h = makeHarness({ script: [{ text: 'Never asked.' }], checkpoint: () => new Promise(() => undefined), timings: { disposeMs: 80 } });
    h.session.send('Start something');
    await h.waitFor((e) => e.type === 'message' && e.message.role === 'user');
    const started = Date.now();
    await h.session.dispose();
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
