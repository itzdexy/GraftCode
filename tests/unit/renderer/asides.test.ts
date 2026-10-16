import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asideQuestion, MAX_ASIDES, useAsides, type Aside } from '../../../src/renderer/src/stores/asides';
import { invoke } from '../../../src/renderer/src/lib/ipc';

vi.mock('../../../src/renderer/src/lib/ipc', async (original) => ({ ...await original<object>(), invoke: vi.fn() }));

/** A request to the main process that the test answers when it chooses to. */
function pendingAnswer(): { resolve(text: string): void; reject(error: Error): void } {
  let resolve!: (value: { text: string }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ text: string }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  vi.mocked(invoke).mockImplementation(((channel: string) => (channel === 'sessions:aside' ? promise : Promise.resolve({ ok: true }))) as typeof invoke);
  return { resolve: (text) => resolve({ text }), reject };
}

const shown = (sessionId = 's'): Aside[] => useAsides.getState().bySession[sessionId] ?? [];
const calls = (channel: string): unknown[] => vi.mocked(invoke).mock.calls.filter((call) => call[0] === channel).map((call) => call[1]);
/** Lets the promise callbacks that follow an answer run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useAsides.setState({ bySession: {} });
});

describe('the question after /btw', () => {
  it('is what follows the command, over as many lines as were typed', () => {
    expect(asideQuestion('/btw what does parse return?')).toBe('what does parse return?');
    expect(asideQuestion('  /BTW   two\nlines  ')).toBe('two\nlines');
  });

  it('is empty when nothing was typed after it, and no question at all for other text', () => {
    expect(asideQuestion('/btw')).toBe('');
    expect(asideQuestion('/btw   ')).toBe('');
    expect(asideQuestion('/btwx what')).toBeNull();
    expect(asideQuestion('by the way /btw')).toBeNull();
    expect(asideQuestion('/context')).toBeNull();
  });
});

describe('side questions on screen', () => {
  it('shows a question as being asked, fills in the answer as it is heard, and ends with the answer it was given', async () => {
    const answer = pendingAnswer();
    useAsides.getState().ask('s', 'What is the file called now?');
    expect(shown()).toMatchObject([{ question: 'What is the file called now?', status: 'asking', answer: '', error: null }]);
    const askId = shown()[0]!.id;
    expect(calls('sessions:aside')).toEqual([{ id: 's', askId, question: 'What is the file called now?' }]);

    useAsides.getState().hear('s', askId, 'It is ');
    useAsides.getState().hear('s', askId, 'src/parser.ts');
    expect(shown()[0]).toMatchObject({ status: 'asking', answer: 'It is src/parser.ts' });

    answer.resolve('It is src/parser.ts now.');
    await settle();
    expect(shown()[0]).toMatchObject({ status: 'answered', answer: 'It is src/parser.ts now.', error: null });
  });

  it('says why when the question could not be answered, and keeps what had been heard', async () => {
    const answer = pendingAnswer();
    useAsides.getState().ask('s', 'Why?');
    useAsides.getState().hear('s', shown()[0]!.id, 'Because');
    answer.reject(new Error('The key was refused.'));
    await settle();
    expect(shown()[0]).toMatchObject({ status: 'failed', answer: 'Because', error: 'The key was refused.' });
  });

  it('stops asking when a question is dismissed, and never brings it back', async () => {
    const answer = pendingAnswer();
    useAsides.getState().ask('s', 'Why?');
    const askId = shown()[0]!.id;
    useAsides.getState().dismiss('s', askId);
    expect(shown()).toEqual([]);
    expect(calls('sessions:cancelAside')).toEqual([{ id: 's', askId }]);
    answer.reject(new Error('The side question was cancelled.'));
    useAsides.getState().hear('s', askId, 'late');
    await settle();
    expect(shown()).toEqual([]);
  });

  it('dismisses an answered question without asking the session for anything', async () => {
    const answer = pendingAnswer();
    useAsides.getState().ask('s', 'Why?');
    answer.resolve('Because.');
    await settle();
    useAsides.getState().dismiss('s', shown()[0]!.id);
    expect(shown()).toEqual([]);
    expect(calls('sessions:cancelAside')).toEqual([]);
  });

  it('keeps the newest few, and stops asking one that falls off the end', () => {
    pendingAnswer();
    for (let i = 0; i <= MAX_ASIDES; i++) useAsides.getState().ask('s', `Question ${String(i)}?`);
    expect(shown().map((a) => a.question)).toEqual(Array.from({ length: MAX_ASIDES }, (_, i) => `Question ${String(i + 1)}?`));
    expect(calls('sessions:cancelAside')).toHaveLength(1);
  });

  it('keeps each session to its own questions, and forgets those of a session that is gone', () => {
    pendingAnswer();
    useAsides.getState().ask('s', 'Here?');
    useAsides.getState().ask('other', 'There?');
    expect(shown().map((a) => a.question)).toEqual(['Here?']);
    expect(shown('other').map((a) => a.question)).toEqual(['There?']);
    useAsides.getState().hear('other', shown()[0]!.id, 'not for this one');
    expect(shown('other')[0]!.answer).toBe('');
    useAsides.getState().forget('s');
    expect(shown()).toEqual([]);
    expect(shown('other')).toHaveLength(1);
  });
});
