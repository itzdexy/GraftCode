import { describe, expect, it } from 'vitest';
import { allow, makeLoopHarness, resultTexts, testTool } from '../support/loopHarness';
import { ProviderError } from '../../src/main/providers/errors';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('tool calls in one response', () => {
  /** Tools that note when they start and end, and how many were running at the time. */
  function tracked() {
    const trace: string[] = [];
    let running = 0;
    let peak = 0;
    const work = (label: (input: Record<string, unknown>) => string, ms: number) => async (input: Record<string, unknown>): Promise<string> => {
      const id = label(input);
      trace.push(`start ${id}`);
      running++;
      peak = Math.max(peak, running);
      await wait(ms);
      running--;
      trace.push(`end ${id}`);
      return id;
    };
    return {
      trace,
      peak: () => peak,
      tools: [
        testTool('Look', { safe: true, run: work((i) => `look ${String(i.n)}`, 30) }),
        testTool('Change', { safe: false, run: work((i) => `change ${String(i.n)}`, 10) })
      ]
    };
  }

  it('runs the safe ones together, and each other one alone, in the order they were given', async () => {
    const t = tracked();
    const h = makeLoopHarness({
      tools: t.tools,
      script: [
        {
          toolCalls: [
            { name: 'Look', input: { n: 1 } },
            { name: 'Look', input: { n: 2 } },
            { name: 'Change', input: { n: 3 } },
            { name: 'Look', input: { n: 4 } },
            { name: 'Look', input: { n: 5 } }
          ]
        },
        { text: 'Done.' }
      ]
    });
    const result = await h.run('go');
    expect(result.reason).toBe('completed');
    // Both of the first two were running before either finished; the change waited for them; the last two overlapped after it.
    const at = (entry: string): number => t.trace.indexOf(entry);
    expect(Math.max(at('start look 1'), at('start look 2'))).toBeLessThan(Math.min(at('end look 1'), at('end look 2')));
    expect(at('start change 3')).toBeGreaterThan(Math.max(at('end look 1'), at('end look 2')));
    expect(Math.min(at('start look 4'), at('start look 5'))).toBeGreaterThan(at('end change 3'));
    expect(Math.max(at('start look 4'), at('start look 5'))).toBeLessThan(Math.min(at('end look 4'), at('end look 5')));
    expect(t.peak()).toBe(2);
    // Results come back in the order of the calls, whatever order they finished in.
    expect(resultTexts(h.stored.find((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result')))).toEqual(['look 1', 'look 2', 'change 3', 'look 4', 'look 5']);
  });

  it('never overlaps a call that needs the user to approve it with the ones around it', async () => {
    const t = tracked();
    const h = makeLoopHarness({
      tools: t.tools,
      decide: (tool) => (tool === 'Look' ? allow : { ...allow, behavior: 'ask' }),
      script: [{ toolCalls: [{ name: 'Look', input: { n: 1 } }, { name: 'Change', input: { n: 2 } }, { name: 'Look', input: { n: 3 } }] }, { text: 'Done.' }]
    });
    await h.run('go');
    expect(t.trace).toEqual(['start look 1', 'end look 1', 'start change 2', 'end change 2', 'start look 3', 'end look 3']);
  });

  it('stops before the next group when the turn is interrupted, and says what did not run', async () => {
    const t = tracked();
    const controller = new AbortController();
    const h = makeLoopHarness({
      tools: [
        t.tools[0]!,
        testTool('Stopper', {
          run: () => {
            controller.abort();
            return 'stopped';
          }
        })
      ],
      script: [{ toolCalls: [{ name: 'Look', input: { n: 1 } }, { name: 'Stopper', input: {} }, { name: 'Look', input: { n: 2 } }, { name: 'Look', input: { n: 3 } }] }, { text: 'never' }]
    });
    const result = await h.run('go', controller.signal);
    expect(result.reason).toBe('interrupted');
    expect(t.trace).toEqual(['start look 1', 'end look 1']);
    expect(resultTexts(h.stored.find((m) => m.role === 'user' && m.content.some((b) => b.type === 'tool_result')))).toEqual([
      'look 1',
      'stopped',
      'Not run: the turn was interrupted.',
      'Not run: the turn was interrupted.'
    ]);
  });
});

describe('a reply that ran into the context window', () => {
  const summary = () => [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Summary of the work so far.' }] }];

  it('makes room and carries on, instead of stopping and asking the user to', async () => {
    const h = makeLoopHarness({
      tools: [],
      script: [{ text: 'Reading the whole repository…', finish: 'context_window' }, { text: 'Finished.' }],
      maybeCompact: (_history, _tokens, overflow) => (overflow ? summary() : null)
    });
    const result = await h.run('big job');
    expect(result).toMatchObject({ reason: 'completed', finalText: 'Finished.' });
    expect(h.provider.requests[1]!.messages).toEqual(summary());
    expect(h.notices().join(' ')).not.toMatch(/context window/i);
  });

  it('says so when there is nothing to compact and the window is still full', async () => {
    const h = makeLoopHarness({
      tools: [],
      script: [{ text: 'Reading…', finish: 'context_window' }],
      maybeCompact: () => null
    });
    const result = await h.run('big job');
    expect(result.reason).toBe('error');
    expect(result.error).toMatchObject({ code: 'context_length' });
  });

  it('tries once, then leaves the turn to the user when it fills up again', async () => {
    const h = makeLoopHarness({
      tools: [],
      script: [{ text: 'First part.', finish: 'context_window' }, { text: 'Second part.', finish: 'context_window' }],
      maybeCompact: (_history, _tokens, overflow) => (overflow ? summary() : null)
    });
    const result = await h.run('big job');
    expect(result.reason).toBe('completed');
    expect(h.provider.requests).toHaveLength(2);
    expect(h.notices().join(' ')).toMatch(/context window/i);
  });
});

describe('a model that keeps failing', () => {
  const overloaded = new ProviderError('overloaded', 'The provider is overloaded (529).');

  it('hands the turn to the backup model and says so', async () => {
    const h = makeLoopHarness({ tools: [], script: [{ error: overloaded }], backup: [{ text: 'Answered by the backup.' }] });
    const result = await h.run('hello');
    expect(result).toMatchObject({ reason: 'completed', finalText: 'Answered by the backup.' });
    expect(h.notices()).toEqual(["Fake Model isn't answering (overloaded). Continuing with Backup Model."]);
    expect(h.stored.at(-1)?.meta.model).toEqual({ providerId: 'backup', modelId: 'backup-model' });
    expect(h.backup!.requests[0]!.model.ref.modelId).toBe('backup-model');
  });

  it('names the other reasons, and stays put for failures another model would not fix', async () => {
    for (const [code, reason] of [['rate_limit', 'rate limited'], ['server', 'server error'], ['network', 'unreachable']] as const) {
      const h = makeLoopHarness({ tools: [], script: [{ error: new ProviderError(code, 'x') }], backup: [{ text: 'ok' }] });
      await h.run('hello');
      expect(h.notices()[0]).toBe(`Fake Model isn't answering (${reason}). Continuing with Backup Model.`);
    }
    for (const code of ['auth', 'bad_request', 'context_length'] as const) {
      const h = makeLoopHarness({ tools: [], script: [{ error: new ProviderError(code, 'x') }], backup: [{ text: 'never' }] });
      expect((await h.run('hello')).error).toMatchObject({ code });
      expect(h.backup!.requests).toHaveLength(0);
    }
  });

  it('does not switch once part of a reply has arrived', async () => {
    const h = makeLoopHarness({ tools: [], script: [{ error: overloaded, partialText: 'Half an ans' }], backup: [{ text: 'never' }] });
    expect((await h.run('hello')).reason).toBe('error');
    expect(h.backup!.requests).toHaveLength(0);
  });

  it('switches once: the backup model’s own failure ends the turn', async () => {
    const h = makeLoopHarness({ tools: [], script: [{ error: overloaded }], backup: [{ error: new ProviderError('server', 'Provider error (500).') }] });
    expect((await h.run('hello')).error).toMatchObject({ code: 'server' });
    expect(h.backup!.requests).toHaveLength(1);
  });

  it('takes over in the middle of a turn, with the work so far, and keeps the turn to its end', async () => {
    const h = makeLoopHarness({
      tools: [testTool('Look', { safe: true, run: () => 'what the tool saw' })],
      script: [{ thinking: 'Let me look.', toolCalls: [{ name: 'Look', input: {} }] }, { error: overloaded }],
      backup: [{ toolCalls: [{ name: 'Look', input: { again: true } }] }, { text: 'Seen twice.' }]
    });
    const result = await h.run('look');
    expect(result).toMatchObject({ reason: 'completed', finalText: 'Seen twice.', toolCalls: 2 });
    // The backup model gets the calls and their results, without the first model's thinking.
    const sent = JSON.stringify(h.backup!.requests[0]!.messages);
    expect(sent).toContain('what the tool saw');
    expect(sent).not.toContain('Let me look.');
    // The rest of the turn stays with it: the first model is not asked again.
    expect(h.provider.requests).toHaveLength(2);
    expect(h.backup!.requests).toHaveLength(2);
    expect(h.notices()).toHaveLength(1);
  });

  it('reports the failure as it was when there is no backup model, or asking for one fails', async () => {
    const none = makeLoopHarness({ tools: [], script: [{ error: overloaded }], fallback: () => Promise.resolve(null) });
    expect((await none.run('hello')).error).toEqual({ code: 'overloaded', message: 'The provider is overloaded (529).' });
    expect(none.notices()).toEqual([]);
    const broken = makeLoopHarness({ tools: [], script: [{ error: overloaded }], fallback: () => Promise.reject(new Error('settings unreadable')) });
    expect((await broken.run('hello')).error).toEqual({ code: 'overloaded', message: 'The provider is overloaded (529).' });
    const plain = makeLoopHarness({ tools: [], script: [{ error: overloaded }] });
    expect((await plain.run('hello')).error).toMatchObject({ code: 'overloaded' });
  });

  it('stops without switching when the user stopped the turn while a backup was looked up', async () => {
    const controller = new AbortController();
    const h = makeLoopHarness({
      tools: [],
      script: [{ error: overloaded }],
      backup: [{ text: 'never' }],
      fallback: (offer) => {
        controller.abort();
        return Promise.resolve(offer);
      }
    });
    expect((await h.run('hello', controller.signal)).reason).toBe('interrupted');
    expect(h.backup!.requests).toHaveLength(0);
    expect(h.notices()).toEqual([]);
  });
});
