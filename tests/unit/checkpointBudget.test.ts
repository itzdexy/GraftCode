import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../src/shared/schemas/agentEvents';
import { makeHarness, type Harness } from '../support/sessionHarness';

/**
 * A turn of a code session starts from a snapshot of its folder, for Rewind.
 * A folder too large to snapshot quickly (a whole Downloads folder) used to
 * keep the message unseen, the turn unstoppable and the session undeletable.
 * The snapshot is taken while the model starts answering; what changes a file
 * waits for it.
 */

let open: Harness[] = [];
afterEach(async () => {
  for (const h of open) await h.session.dispose();
  open = [];
});

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
  it('is taken while the model starts answering: what changes a file waits for it, and it is named on the message', async () => {
    let release: (id: string) => void = () => undefined;
    const h = makeHarness({
      mode: 'bypass',
      script: [{ toolCalls: [{ name: 'Write', input: { file_path: 'plan.md', content: '# Plan\n' } }] }, { text: 'Done.' }],
      checkpoint: () => new Promise((resolve) => (release = resolve))
    });
    open.push(h);
    h.session.send('Write the plan');
    const shown = await h.waitFor((e) => e.type === 'message' && e.message.role === 'user');
    if (shown.type !== 'message') throw new Error('unreachable');
    expect(shown.message.meta.typed).toBe('Write the plan');
    // The model is asked at once; the Write it asks for waits for the snapshot.
    await vi.waitFor(() => expect(h.provider.requests).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fs.existsSync(path.join(h.projectDir, 'plan.md'))).toBe(false);
    release('checkpoint-1');
    await h.session.idle();
    expect(fs.readFileSync(path.join(h.projectDir, 'plan.md'), 'utf8')).toBe('# Plan\n');
    expect(h.store.listMessages(h.session.id).find((m) => m.id === shown.message.id)?.meta.checkpointId).toBe('checkpoint-1');
  });

  it('lets a reply in words go out without waiting for it', async () => {
    let release: (id: string) => void = () => undefined;
    const h = makeHarness({ script: [{ text: 'Here is the answer.' }], checkpoint: () => new Promise((resolve) => (release = resolve)) });
    open.push(h);
    h.session.send('What does this project do?');
    const end = await h.waitFor((e) => e.type === 'turn-end');
    expect(end.type === 'turn-end' && end.reason).toBe('completed');
    expect(h.store.listMessages(h.session.id).at(-1)?.content).toEqual([{ type: 'text', text: 'Here is the answer.' }]);
    release('checkpoint-1');
    await h.session.idle();
    expect(h.store.listMessages(h.session.id)[0]?.meta.checkpointId).toBe('checkpoint-1');
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
    expect(notices(h.events).some((text) => /^Rewind is off in .+: it took longer than 0 seconds to snapshot/.test(text))).toBe(true);
    // The turn went on without one.
    expect(h.provider.requests).toHaveLength(1);
    await h.turn('And again');
    expect(calls).toBe(1);
    expect(h.provider.requests).toHaveLength(2);
    expect(notices(h.events).filter((text) => text.startsWith('Rewind is off'))).toHaveLength(1);
  });

  it('ends at once when the turn is stopped, and the turn ends with it', async () => {
    const seen = { signal: null as AbortSignal | null };
    const h = makeHarness({ script: [{ text: 'Too late.', chunkDelayMs: 5000 }], checkpoint: endless(seen) });
    open.push(h);
    h.session.send('Start something');
    await h.waitFor((e) => e.type === 'message' && e.message.role === 'user');
    h.session.interrupt();
    const end = await h.waitFor((e) => e.type === 'turn-end');
    expect(end.type === 'turn-end' && end.reason).toBe('interrupted');
    await h.session.idle();
    expect(seen.signal?.aborted).toBe(true);
    // The message says it was stopped, rather than sitting there unanswered.
    expect(h.store.listMessages(h.session.id).map((m) => `${m.role}:${m.meta.kind ?? 'normal'}`)).toEqual(['user:normal', 'assistant:notice']);
  });

  it('never keeps a session from closing, even when the snapshot does not hear the stop', async () => {
    const h = makeHarness({ script: [{ text: 'An answer.' }], checkpoint: () => new Promise(() => undefined), timings: { disposeMs: 80 } });
    h.session.send('Start something');
    await h.waitFor((e) => e.type === 'message' && e.message.role === 'user');
    const started = Date.now();
    await h.session.dispose();
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
