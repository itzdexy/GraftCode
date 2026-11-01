import { describe, expect, it } from 'vitest';
import { Suggestions, suggestionKey, type CancelToken } from '../../../src/renderer/src/features/panels/editorAiModel';

/** A token Monaco would hand over, cancelled when the test says the user typed again. */
function token(): CancelToken & { cancel(): void } {
  const listeners = new Set<() => void>();
  const state = { cancelled: false };
  return {
    get isCancellationRequested() {
      return state.cancelled;
    },
    onCancellationRequested(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    cancel() {
      state.cancelled = true;
      for (const listener of listeners) listener();
    }
  };
}

/** Suggestions with a clock the test moves, and what they told the main process and the status line. */
function harness() {
  const clock = { now: 1_000 };
  const cancelled: string[] = [];
  const notes: Array<string | null> = [];
  let ids = 0;
  const suggestions = new Suggestions({ cancel: (id) => cancelled.push(id), note: (text) => notes.push(text), newId: () => `r${++ids}`, now: () => clock.now });
  const asked: string[] = [];
  const answer = (text: string) => (requestId: string) => {
    asked.push(requestId);
    return Promise.resolve(text);
  };
  return { clock, cancelled, notes, suggestions, asked, answer };
}

describe('suggestions as you type', () => {
  it('keys a suggestion by the file and the text right around the cursor', () => {
    const far = 'x'.repeat(2_000);
    expect(suggestionKey('a.ts', `${far}const a = `, ';')).toBe(suggestionKey('a.ts', `${far.replace('x', 'y')}const a = `, ';'));
    expect(suggestionKey('a.ts', 'const a = ', ';')).not.toBe(suggestionKey('b.ts', 'const a = ', ';'));
    expect(suggestionKey('a.ts', 'const a = ', ';')).not.toBe(suggestionKey('a.ts', 'const a = ', ')'));
  });

  it('does not ask again for a place it has an answer for, empty answers included', async () => {
    const { suggestions, asked, answer } = harness();
    expect(await suggestions.suggest('k1', answer('42;'), token())).toBe('42;');
    expect(await suggestions.suggest('k1', answer('other'), token())).toBe('42;');
    expect(await suggestions.suggest('k2', answer(''), token())).toBeNull();
    expect(await suggestions.suggest('k2', answer('late'), token())).toBeNull();
    expect(asked).toEqual(['r1', 'r2']);
  });

  it('forgets the oldest places once it holds many', async () => {
    const { suggestions, asked, answer } = harness();
    for (let i = 0; i <= 64; i++) await suggestions.suggest(`k${i}`, answer('x'), token());
    await suggestions.suggest('k64', answer('x'), token());
    expect(asked).toHaveLength(65);
    await suggestions.suggest('k0', answer('x'), token());
    expect(asked).toHaveLength(66);
  });

  it('cancels the request in flight when typing goes on, and keeps its answer for when the cursor is back', async () => {
    const { suggestions, cancelled, answer } = harness();
    let finish: (text: string) => void = () => undefined;
    const typing = token();
    const pending = suggestions.suggest('k1', () => new Promise((resolve) => (finish = resolve)), typing);
    typing.cancel();
    expect(cancelled).toEqual(['r1']);
    finish('late answer');
    expect(await pending).toBeNull();
    // Undone back to the same place: the answer that came late is there without asking.
    expect(await suggestions.suggest('k1', answer('asked again'), token())).toBe('late answer');
    // A request that ends with "cancelled" is no failure.
    const again = token();
    const refused = suggestions.suggest('k2', () => Promise.reject(Object.assign(new Error('The request was cancelled.'), { code: 'cancelled' })), again);
    expect(await refused).toBeNull();
    expect(suggestions.ready()).toBe(true);
  });

  it('pauses after a failure, says why once, and says nothing more once it works again', async () => {
    const { clock, suggestions, notes, asked, answer } = harness();
    const fail = () => Promise.reject(Object.assign(new Error('Choose a model for this session first.'), { code: 'no_model' }));
    expect(await suggestions.suggest('k1', fail, token())).toBeNull();
    expect(notes).toEqual(['Suggestions paused: Choose a model for this session first.']);
    expect(suggestions.ready()).toBe(false);
    expect(await suggestions.suggest('k2', answer('x'), token())).toBeNull();
    expect(asked).toEqual([]);
    clock.now += 30_000;
    expect(suggestions.ready()).toBe(true);
    // The same failure again pauses longer and is not announced a second time.
    await suggestions.suggest('k3', fail, token());
    expect(notes).toHaveLength(1);
    clock.now += 30_000;
    expect(suggestions.ready()).toBe(false);
    clock.now += 30_000;
    expect(await suggestions.suggest('k4', answer('works'), token())).toBe('works');
    expect(notes).toEqual(['Suggestions paused: Choose a model for this session first.', null]);
  });

  it('stops for good in a file that may hold secrets', async () => {
    const { clock, suggestions, notes, asked, answer } = harness();
    await suggestions.suggest('k1', () => Promise.reject(Object.assign(new Error('secret'), { code: 'secret_file' })), token());
    clock.now += 60 * 60_000;
    expect(suggestions.ready()).toBe(false);
    expect(await suggestions.suggest('k2', answer('x'), token())).toBeNull();
    expect(asked).toEqual([]);
    expect(notes).toEqual(['Suggestions are off for this file: it may hold keys or passwords.']);
  });
});
