import { create } from 'zustand';
import { capped, MAX_TEXT, parseStored, type ReviewComment } from '../features/review/reviewModel';
import { useSessions } from './sessions';

/** Where this window keeps the comments that wait for a message. */
export const REVIEW_KEY = 'graft.review.v1';

function load(): Record<string, ReviewComment[]> {
  // Outside a window (the unit tests) there is nothing stored, and asking would only draw a warning.
  if (typeof window === 'undefined') return {};
  try {
    return parseStored(localStorage.getItem(REVIEW_KEY));
  } catch {
    return {};
  }
}

function save(bySession: Record<string, ReviewComment[]>): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(REVIEW_KEY, JSON.stringify(bySession));
  } catch {
    // rocky: when storage is full or unavailable the comments live in memory, until the window closes.
  }
}

interface ReviewState {
  /** The comments waiting for each session's next message. */
  bySession: Record<string, ReviewComment[]>;
  add: (sessionId: string, comment: Omit<ReviewComment, 'id' | 'at'>) => void;
  edit: (sessionId: string, id: string, text: string) => void;
  remove: (sessionId: string, id: string) => void;
  clear: (sessionId: string) => void;
}

export const useReview = create<ReviewState>((set, get) => {
  const put = (bySession: Record<string, ReviewComment[]>): void => {
    const kept = capped(bySession);
    set({ bySession: kept });
    save(kept);
  };
  const change = (sessionId: string, list: (now: ReviewComment[]) => ReviewComment[]): void => put({ ...get().bySession, [sessionId]: list(get().bySession[sessionId] ?? []) });
  return {
    bySession: load(),
    add: (sessionId, comment) => {
      const text = comment.text.trim().slice(0, MAX_TEXT);
      if (text.length > 0) change(sessionId, (now) => [...now, { ...comment, text, id: crypto.randomUUID(), at: Date.now() }]);
    },
    edit: (sessionId, id, written) => {
      const text = written.trim().slice(0, MAX_TEXT);
      if (text.length > 0) change(sessionId, (now) => now.map((comment) => (comment.id === id ? { ...comment, text } : comment)));
    },
    remove: (sessionId, id) => change(sessionId, (now) => now.filter((comment) => comment.id !== id)),
    clear: (sessionId) => change(sessionId, () => [])
  };
});

const NONE: ReviewComment[] = [];

/** A session's waiting comments. The same list while nothing changed, so a component that reads it is not drawn again for nothing. */
export function commentsOf(state: Pick<ReviewState, 'bySession'>, sessionId: string): ReviewComment[] {
  return state.bySession[sessionId] ?? NONE;
}

// Comments go with their session: when it is deleted, nothing written for it is kept.
useSessions.subscribe((state, previous) => {
  if (state.summaries === previous.summaries) return;
  const gone = Object.keys(previous.summaries).filter((id) => !(id in state.summaries) && id in useReview.getState().bySession);
  for (const id of gone) useReview.getState().clear(id);
});
