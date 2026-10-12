import { useMemo } from 'react';
import { commentsOf, useReview } from '../../stores/review';
import type { DiffComments } from '../diff/DiffView';
import type { ReviewComment } from './reviewModel';

const NONE: ReviewComment[] = [];

/**
 * What a diff needs to take comments on one file of a session: the comments
 * that wait on that file, and how one is written, changed and deleted. Null
 * without a session or a file, and the diff is then one to read.
 */
export function useDiffComments(sessionId: string | null, path: string | null): DiffComments | null {
  const waiting = useReview((state) => (sessionId === null ? NONE : commentsOf(state, sessionId)));
  return useMemo(() => {
    if (sessionId === null || path === null) return null;
    const review = useReview.getState();
    return {
      list: waiting.filter((comment) => comment.path === path),
      onAdd: (at, text) => review.add(sessionId, { path, line: at.line, endLine: at.line, side: at.side, quote: at.quote, text }),
      onEdit: (id, text) => review.edit(sessionId, id, text),
      onDelete: (id) => review.remove(sessionId, id)
    };
  }, [sessionId, path, waiting]);
}
