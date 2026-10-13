import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchOf, useTextSearch } from '../../../src/renderer/src/stores/textSearch';
import { invoke } from '../../../src/renderer/src/lib/ipc';
import type { TextSearchResult } from '../../../src/shared/schemas/textSearch';

vi.mock('../../../src/renderer/src/lib/ipc', async (original) => ({ ...await original<object>(), invoke: vi.fn() }));

const result = (path: string): TextSearchResult => ({ files: [{ path, matches: [{ line: 1, column: 1, text: 'x', ranges: [[0, 1]] }] }], lines: 1, truncated: false });

/** Searches that the test answers when it chooses to, in the order they were asked. */
function pendingSearches(): Array<{ resolve(value: TextSearchResult): void; reject(error: Error): void }> {
  const asked: Array<{ resolve(value: TextSearchResult): void; reject(error: Error): void }> = [];
  vi.mocked(invoke).mockImplementation(() => new Promise<TextSearchResult>((resolve, reject) => asked.push({ resolve, reject })));
  return asked;
}

const state = (sessionId = 's') => searchOf(useTextSearch.getState(), sessionId);
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useTextSearch.setState({ bySession: {}, focus: null });
});

describe('the search of a session', () => {
  it('starts empty, looking for text as written and ignoring case', () => {
    expect(state()).toMatchObject({ query: { text: '', regex: false, caseSensitive: false, wholeWord: false, files: '' }, status: 'idle', result: null });
  });

  it('changes what is looked for without searching', () => {
    useTextSearch.getState().change('s', { text: 'total', wholeWord: true });
    expect(state().query).toMatchObject({ text: 'total', wholeWord: true, regex: false });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('asks for the session and the query, and shows the answer', async () => {
    const asked = pendingSearches();
    useTextSearch.getState().change('s', { text: 'total' });
    void useTextSearch.getState().run('s', 'key-1');
    expect(state().status).toBe('searching');
    expect(invoke).toHaveBeenCalledWith('files:searchText', { sessionId: 's', search: { text: 'total', regex: false, caseSensitive: false, wholeWord: false, files: '' } });
    asked[0]!.resolve(result('a.ts'));
    await settle();
    expect(state()).toMatchObject({ status: 'done', result: result('a.ts'), searched: { text: 'total' }, at: 'key-1', error: null });
  });

  it('keeps the answer of the search asked last, whichever comes back first', async () => {
    const asked = pendingSearches();
    useTextSearch.getState().change('s', { text: 'to' });
    void useTextSearch.getState().run('s', null);
    useTextSearch.getState().change('s', { text: 'total' });
    void useTextSearch.getState().run('s', null);
    asked[1]!.resolve(result('late.ts'));
    await settle();
    asked[0]!.resolve(result('early.ts'));
    await settle();
    expect(state().result).toEqual(result('late.ts'));
    expect(state().searched?.text).toBe('total');
  });

  it('says what went wrong and lists nothing', async () => {
    const asked = pendingSearches();
    useTextSearch.getState().change('s', { text: '(', regex: true });
    void useTextSearch.getState().run('s', null);
    asked[0]!.reject(new Error("That pattern can't be read: unclosed group."));
    await settle();
    expect(state()).toMatchObject({ status: 'error', error: "That pattern can't be read: unclosed group.", result: null });
  });

  it('asks nothing for an empty box, and clears what was listed', async () => {
    const asked = pendingSearches();
    useTextSearch.getState().change('s', { text: 'total' });
    void useTextSearch.getState().run('s', null);
    asked[0]!.resolve(result('a.ts'));
    await settle();
    useTextSearch.getState().change('s', { text: '   ' });
    void useTextSearch.getState().run('s', null);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(state()).toMatchObject({ status: 'idle', result: null, searched: null });
  });

  it('drops the answer to a search of a box that has been emptied since', async () => {
    const asked = pendingSearches();
    useTextSearch.getState().change('s', { text: 'total' });
    void useTextSearch.getState().run('s', null);
    useTextSearch.getState().change('s', { text: '' });
    void useTextSearch.getState().run('s', null);
    asked[0]!.resolve(result('a.ts'));
    await settle();
    expect(state().result).toBeNull();
  });

  it('folds a file and unfolds it, and unfolds everything for a new answer', async () => {
    const asked = pendingSearches();
    useTextSearch.getState().toggleFold('s', 'a.ts');
    expect(state().folded).toEqual({ 'a.ts': true });
    useTextSearch.getState().toggleFold('s', 'a.ts');
    expect(state().folded).toEqual({});
    useTextSearch.getState().toggleFold('s', 'a.ts');
    useTextSearch.getState().change('s', { text: 'total' });
    void useTextSearch.getState().run('s', null);
    asked[0]!.resolve(result('a.ts'));
    await settle();
    expect(state().folded).toEqual({});
  });

  it('keeps each session to itself', () => {
    useTextSearch.getState().change('a', { text: 'one' });
    useTextSearch.getState().change('b', { text: 'two' });
    expect(state('a').query.text).toBe('one');
    expect(state('b').query.text).toBe('two');
  });

  it('asks for the keyboard, with the text that was selected when there was some', () => {
    useTextSearch.getState().change('s', { text: 'kept' });
    useTextSearch.getState().open('s', null);
    expect(useTextSearch.getState().focus).toMatchObject({ sessionId: 's' });
    expect(state().query.text).toBe('kept');
    const before = useTextSearch.getState().focus!.seq;
    useTextSearch.getState().open('s', 'parseAccelerator');
    expect(state().query.text).toBe('parseAccelerator');
    expect(useTextSearch.getState().focus!.seq).toBeGreaterThan(before);
  });
});
