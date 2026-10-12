/**
 * Comments on lines of code, for the agent (pure; unit-tested). A comment
 * changes nothing in the project and nothing in a stored message: it waits
 * with its session and is added, as text, to the next message the user sends.
 */

import { z } from 'zod';

export const MAX_QUOTE = 200;
export const MAX_TEXT = 2000;
/** The newest comments kept for one session… */
export const MAX_PER_SESSION = 100;
/** …and the sessions commented on last that keep theirs. */
export const MAX_SESSIONS = 50;

export const ReviewCommentSchema = z.object({
  id: z.string().min(1).max(64),
  /** When it was written. */
  at: z.number(),
  /** The file, as the diff or the editor names it. */
  path: z.string().min(1).max(4096),
  line: z.number().int().min(1),
  /** The same as `line` unless several lines were selected. */
  endLine: z.number().int().min(1),
  /** `old` for a line a change removed, which is numbered as the file was before. */
  side: z.enum(['old', 'new']),
  /** The line's text (the first line of a selection), so the comment still says what it is about after the file has moved on. */
  quote: z.string().max(MAX_QUOTE),
  text: z.string().min(1).max(MAX_TEXT)
});
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;

const StoredSchema = z.record(z.string(), z.array(ReviewCommentSchema));

/** What is quoted of a line: its first line, without the indent, cut to 200 characters. */
export function quoteOf(lineText: string): string {
  return (lineText.split('\n')[0] ?? '').trim().slice(0, MAX_QUOTE);
}

/** Where a comment is: `src/health.js:14`, `src/health.js:20-24 (removed)`. */
export function commentPlace(comment: Pick<ReviewComment, 'path' | 'line' | 'endLine' | 'side'>): string {
  const lines = comment.endLine === comment.line ? String(comment.line) : `${String(comment.line)}-${String(comment.endLine)}`;
  return `${comment.path}:${lines}${comment.side === 'old' ? ' (removed)' : ''}`;
}

/** A comment as the agent reads it: its place, the line it is about in backticks, and what to change, on one line. */
export function commentLine(comment: ReviewComment): string {
  const quote = comment.quote.trim().length > 0 ? ` \`${comment.quote.replace(/`/g, "'")}\`` : '';
  return `- ${commentPlace(comment)}${quote} — ${comment.text.split(/\s+/).join(' ').trim()}`;
}

/** Comments as they are listed and sent: by file, then line, then when they were written. */
export function inOrder(comments: readonly ReviewComment[]): ReviewComment[] {
  return [...comments].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.at - b.at));
}

export function commentsLabel(count: number): string {
  return count === 1 ? '1 comment' : `${String(count)} comments`;
}

/**
 * A message with the waiting comments after it, by file and line. A message
 * that starts with `/` or `!` is a command: it comes back as typed and the
 * comments keep waiting. Comments sent with nothing typed stand under a line
 * of their own.
 */
export function withComments(text: string, comments: ReviewComment[]): { text: string; attached: boolean } {
  const typed = text.trim();
  if (comments.length === 0 || typed.startsWith('/') || typed.startsWith('!')) return { text, attached: false };
  const message = typed.length > 0 ? text.trimEnd() : 'Address these comments.';
  return { text: `${message}\n\nComments on the code:\n${inOrder(comments).map(commentLine).join('\n')}`, attached: true };
}

/** What is kept: the newest comments of each session, for the sessions commented on last. A session without comments is not kept. */
export function capped(bySession: Record<string, ReviewComment[]>): Record<string, ReviewComment[]> {
  const sessions = Object.entries(bySession)
    .filter(([, list]) => list.length > 0)
    .map(([id, list]): [string, ReviewComment[]] => [id, list.length > MAX_PER_SESSION ? [...list].sort((a, b) => a.at - b.at).slice(-MAX_PER_SESSION) : list]);
  if (sessions.length <= MAX_SESSIONS) return Object.fromEntries(sessions);
  const newest = (list: ReviewComment[]): number => list.reduce((latest, comment) => Math.max(latest, comment.at), 0);
  const keep = new Set(
    [...sessions]
      .sort((a, b) => newest(b[1]) - newest(a[1]))
      .slice(0, MAX_SESSIONS)
      .map(([id]) => id)
  );
  return Object.fromEntries(sessions.filter(([id]) => keep.has(id)));
}

/** The comments that were stored, or none when what is there is missing, broken or something else. */
export function parseStored(raw: string | null): Record<string, ReviewComment[]> {
  if (raw === null) return {};
  try {
    const parsed = StoredSchema.safeParse(JSON.parse(raw));
    return parsed.success ? capped(parsed.data) : {};
  } catch {
    return {};
  }
}

/**
 * The lines a selection in the editor covers and what to quote for them. A
 * selection that ends at the start of a line does not take that line. With
 * nothing selected it is the cursor's line.
 */
export function selectionAnchor(selection: { startLine: number; endLine: number; endColumn: number }, lineText: (line: number) => string): { line: number; endLine: number; quote: string } {
  const endLine = selection.endLine > selection.startLine && selection.endColumn <= 1 ? selection.endLine - 1 : selection.endLine;
  return { line: selection.startLine, endLine, quote: quoteOf(lineText(selection.startLine)) };
}
