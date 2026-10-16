import { create } from 'zustand';
import type { TextSearchQuery, TextSearchResult } from '@shared/schemas/textSearch';
import { seedFromSelection } from '../features/panels/searchModel';
import { errorText, invoke } from '../lib/ipc';
import { usePanels } from './panels';

/**
 * The Search tab of each session: what is in the box, and what the last
 * search found. It lives here and not in the tab, which is taken down when
 * a result opens its file in the Files tab and has to read the same when
 * the user comes back. In the window only; nothing is stored.
 */
export interface SessionSearch {
  query: TextSearchQuery;
  status: 'idle' | 'searching' | 'done' | 'error';
  /** What `result` is the answer to; the box may have changed since. */
  searched: TextSearchQuery | null;
  result: TextSearchResult | null;
  /** The state of the files when the search ran (the panel's refresh key): the tab says when they have changed since. */
  at: unknown;
  error: string | null;
  /** The files whose lines are folded away. */
  folded: Record<string, true>;
  /** What the matches should become; the replace request is composed from this. Nothing is replaced here. */
  replace: string;
}

const EMPTY: SessionSearch = {
  query: { text: '', regex: false, caseSensitive: false, wholeWord: false, files: '' },
  status: 'idle',
  searched: null,
  result: null,
  at: null,
  error: null,
  folded: {},
  replace: ''
};

interface TextSearchState {
  bySession: Record<string, SessionSearch>;
  /** A request to put the keyboard in a session's box, waiting for its tab to take it; seq tells one from the next. */
  focus: { sessionId: string; seq: number } | null;
  /** Changes what is looked for. Nothing is searched until `run`. */
  change: (sessionId: string, patch: Partial<TextSearchQuery>) => void;
  /** Searches for what is in the box; `at` is the state of the files now. An empty box clears the list. */
  run: (sessionId: string, at: unknown) => Promise<void>;
  toggleFold: (sessionId: string, path: string) => void;
  /** Sets what the matches should become, as the user typed it. */
  setReplace: (sessionId: string, text: string) => void;
  /** Asks for the keyboard in the box, with `seed` as the text to look for when there is one. */
  open: (sessionId: string, seed: string | null) => void;
  /**
   * Hands the waiting request to the tab of this session, once. A tab that is only shown again (its session
   * came back on screen) finds none, and leaves the keyboard where it is.
   */
  takeFocus: (sessionId: string) => boolean;
  /** Drops the search of a session that was removed. */
  forget: (sessionId: string) => void;
}

export const useTextSearch = create<TextSearchState>((set, get) => {
  const patch = (sessionId: string, change: Partial<SessionSearch>): void => {
    set({ bySession: { ...get().bySession, [sessionId]: { ...searchOf(get(), sessionId), ...change } } });
  };
  /** The number of the search each session asked last: an answer to an earlier one is dropped. */
  const asked = new Map<string, number>();
  let focused = 0;
  return {
    bySession: {},
    focus: null,
    change: (sessionId, change) => patch(sessionId, { query: { ...searchOf(get(), sessionId).query, ...change } }),
    run: async (sessionId, at) => {
      const ticket = (asked.get(sessionId) ?? 0) + 1;
      asked.set(sessionId, ticket);
      const search = searchOf(get(), sessionId).query;
      if (search.text.trim().length === 0) {
        patch(sessionId, { status: 'idle', result: null, searched: null, error: null });
        return;
      }
      patch(sessionId, { status: 'searching', error: null });
      try {
        const result = await invoke('files:searchText', { sessionId, search });
        if (asked.get(sessionId) === ticket) patch(sessionId, { status: 'done', result, searched: search, at, folded: {} });
      } catch (error) {
        if (asked.get(sessionId) === ticket) patch(sessionId, { status: 'error', error: errorText(error), result: null, searched: search });
      }
    },
    toggleFold: (sessionId, path) => {
      const { [path]: was, ...rest } = searchOf(get(), sessionId).folded;
      patch(sessionId, { folded: was ? rest : { ...rest, [path]: true } });
    },
    setReplace: (sessionId, text) => patch(sessionId, { replace: text }),
    open: (sessionId, seed) => {
      if (seed !== null) patch(sessionId, { query: { ...searchOf(get(), sessionId).query, text: seed } });
      set({ focus: { sessionId, seq: ++focused } });
    },
    takeFocus: (sessionId) => {
      if (get().focus?.sessionId !== sessionId) return false;
      set({ focus: null });
      return true;
    },
    forget: (sessionId) => {
      asked.delete(sessionId);
      const { [sessionId]: _gone, ...rest } = get().bySession;
      set({ bySession: rest });
    }
  };
});

/** Shows the Search tab of the session's panel with the keyboard in its box. Text selected in the window is what it looks for. */
export function openSearch(sessionId: string): void {
  usePanels.getState().showSearch(sessionId);
  useTextSearch.getState().open(sessionId, seedFromSelection(window.getSelection()?.toString() ?? ''));
}

export function searchOf(state: Pick<TextSearchState, 'bySession'>, sessionId: string): SessionSearch {
  return state.bySession[sessionId] ?? EMPTY;
}
