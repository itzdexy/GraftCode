import { describe, expect, it } from 'vitest';
import { allow, makeLoopHarness, resultTexts, testTool } from '../support/loopHarness';

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
