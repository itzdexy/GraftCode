import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/shared/schemas/agentEvents';
import type { LlmMessage } from '../../src/shared/schemas/messages';
import { answerAside, asideInput } from '../../src/main/agent/aside';
import { ProviderError } from '../../src/main/providers/errors';
import { FakeProvider, fakeModel } from '../support/fakeProvider';
import { makeHarness, type Harness } from '../support/sessionHarness';

const privacy = { noTraining: true, zeroRetention: false };
const history: LlmMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'Rename the parser module.' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Renamed src/parse.ts to src/parser.ts.' },
      { type: 'tool_use', id: 'call_1', name: 'Shell', input: { command: 'npm test' } }
    ]
  }
];

/** The one text the model was sent for a side question. */
function sentText(provider: FakeProvider, call = 0): string {
  const block = provider.requests[call]!.messages[0]!.content[0]!;
  return block.type === 'text' ? block.text : '';
}

describe('a side question to the model', () => {
  it('is asked over the conversation as reading matter, with no tools, and its answer comes back', async () => {
    const provider = new FakeProvider([{ text: 'It is src/parser.ts now.' }]);
    const answer = await answerAside({ provider, model: fakeModel(), history, question: 'What is the file called now?', signal: new AbortController().signal, privacy, cacheKey: 's1', onText: () => undefined });
    expect(answer).toBe('It is src/parser.ts now.');
    const request = provider.requests[0]!;
    expect(request.tools).toEqual([]);
    expect(request.webSearch).toBe(false);
    expect(request.privacy).toEqual(privacy);
    expect(request.effort).toBe('low');
    expect(request.messages).toHaveLength(1);
    expect(request.system).toMatch(/side question/i);
    expect(sentText(provider)).toContain('Renamed src/parse.ts to src/parser.ts.');
    expect(sentText(provider)).toContain('[called Shell');
    expect(sentText(provider).trimEnd().endsWith('What is the file called now?')).toBe(true);
  });

  it('hands the answer on piece by piece while it arrives', async () => {
    const provider = new FakeProvider([{ text: 'One two three.' }]);
    const pieces: string[] = [];
    const answer = await answerAside({ provider, model: fakeModel(), history, question: 'Count.', signal: new AbortController().signal, privacy, cacheKey: 's1', onText: (text) => pieces.push(text) });
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join('')).toBe(answer);
  });

  it('says that nothing has been said yet when the conversation is empty', () => {
    expect(asideInput([], 'What can you do?', 10_000)).toContain('Nothing has been said in the conversation yet.');
  });

  it('keeps the newest of a conversation too long to send whole', () => {
    const long: LlmMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'the first request' }] },
      ...Array.from({ length: 40 }, (_, i): LlmMessage => ({ role: 'assistant', content: [{ type: 'text', text: `step ${String(i)} ${'x'.repeat(200)}` }] }))
    ];
    const input = asideInput(long, 'Where are we?', 2_000);
    expect(input).toContain('the first request');
    expect(input).toContain('step 39');
    expect(input).not.toContain('step 3 ');
    expect(input.length).toBeLessThan(2_600);
  });

  it('fails when the model answers nothing', async () => {
    const provider = new FakeProvider([{ text: '' }]);
    await expect(
      answerAside({ provider, model: fakeModel(), history, question: 'Anything?', signal: new AbortController().signal, privacy, cacheKey: 's1', onText: () => undefined })
    ).rejects.toThrow(/gave no answer/);
  });

  it('passes on what stopped it when the provider refuses', async () => {
    const provider = new FakeProvider([{ error: new ProviderError('auth', 'The key was refused.', { retryable: false }) }]);
    await expect(
      answerAside({ provider, model: fakeModel(), history, question: 'Anything?', signal: new AbortController().signal, privacy, cacheKey: 's1', onText: () => undefined })
    ).rejects.toThrow(/The key was refused/);
  });
});

describe('a side question in a session', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    await h?.session.dispose();
    h = null;
  });

  const asides = (events: AgentEvent[]): string => events.map((e) => (e.type === 'aside' ? e.text : '')).join('');

  it('is answered while a turn runs, and leaves no trace in the conversation', async () => {
    h = makeHarness({ script: [{ text: 'Working through the parser now, one file after another.', chunkDelayMs: 25 }, { text: 'It is src/parser.ts now.' }] });
    h.session.send('Rename the parser module.');
    await h.waitFor((e) => e.type === 'assistant-start');

    const answer = await h.session.aside('ask-1', 'What is the file called now?');
    expect(answer).toBe('It is src/parser.ts now.');
    expect(asides(h.events)).toBe('It is src/parser.ts now.');
    // The turn it was asked beside is still the one running, and ends as it would have.
    expect(h.session.isBusy).toBe(true);
    await h.waitFor((e) => e.type === 'turn-end');

    const stored = h.store.listMessages('session-1');
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(stored)).not.toContain('What is the file called now?');
    expect(JSON.stringify(stored)).not.toContain('It is src/parser.ts now.');
    // The model was asked about the conversation it could see: the user's request was in it.
    expect(sentText(h.provider, 1)).toContain('Rename the parser module.');
    expect(h.provider.requests[1]!.tools).toEqual([]);
  });

  it('is answered with no turn running, and starts none', async () => {
    h = makeHarness({ script: [{ text: 'Nothing yet.' }] });
    expect(await h.session.aside('ask-1', 'What have we done?')).toBe('Nothing yet.');
    expect(h.session.isBusy).toBe(false);
    expect(h.events.some((e) => e.type === 'turn-start' || e.type === 'message')).toBe(false);
    expect(h.store.listMessages('session-1')).toEqual([]);
  });

  it('stops when it is cancelled, and when the session closes', async () => {
    h = makeHarness({ script: [{ text: 'A slow answer that never gets to its end.', chunkDelayMs: 40 }, { text: 'Another slow answer for the second question.', chunkDelayMs: 40 }] });
    const first = h.session.aside('ask-1', 'One?');
    await h.waitFor((e) => e.type === 'aside');
    h.session.cancelAside('ask-1');
    await expect(first).rejects.toThrow(/cancel/i);

    const second = expect(h.session.aside('ask-2', 'Two?')).rejects.toThrow(/cancel/i);
    await h.waitFor((e) => e.type === 'aside' && e.askId === 'ask-2');
    const session = h.session;
    h = null;
    await session.dispose();
    await second;
  });

  it('needs a question', async () => {
    h = makeHarness({ script: [] });
    await expect(h.session.aside('ask-1', '   ')).rejects.toThrow(/Type a question/);
    expect(h.provider.requests).toEqual([]);
  });

  it('is explained instead of being sent to the model when it arrives as a message', async () => {
    h = makeHarness({ script: [] });
    h.session.send('/btw what is the file called now?');
    await h.waitFor((e) => e.type === 'turn-end');
    expect(h.provider.requests).toEqual([]);
    const said = h.store.listMessages('session-1').at(-1)!;
    expect(said.meta.kind).toBe('command-output');
    expect(JSON.stringify(said.content)).toMatch(/side question/i);
  });
});

describe('the list of commands', () => {
  it('offers the side question', async () => {
    const { BUILTIN_COMMANDS } = await import('../../src/main/agent/slashCommands');
    expect(BUILTIN_COMMANDS.find((c) => c.name === 'btw')).toMatchObject({ argumentHint: '[question]' });
  });
});
