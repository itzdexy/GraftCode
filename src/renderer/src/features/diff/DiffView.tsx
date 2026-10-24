import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useCodeThemes } from '../../lib/codeThemes';
import { highlightLines, type Token } from '../../lib/highlight';
import { logError } from '../../lib/log';
import { CommentBox, CommentNote } from '../review/CommentBox';
import { quoteOf, type ReviewComment } from '../review/reviewModel';
import { commentAnchor, commentsAt, coveredRows, hunkTexts, inlineSpans, pieces, toSplitRows, type CommentAnchor, type DiffRow, type Span } from './diffModel';

/** Comments on the lines of a diff: the ones that wait for the next message, and what writing, changing and deleting one does. */
export interface DiffComments {
  list: ReviewComment[];
  onAdd: (at: CommentAnchor & { quote: string }, text: string) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
}

interface DiffViewProps {
  rows: DiffRow[];
  mode: 'unified' | 'split';
  /** Grammar for syntax colours (see languageForPath); none when null or left out. */
  language?: string | null;
  /** "both": the old and the new line number side by side. "one": a single column, the old number on removed lines. */
  gutter?: 'both' | 'one';
  /** False leaves the "@@ -1,3 +1,4 @@" lines out and draws a rule between hunks instead. */
  hunkHeaders?: boolean;
  /** Rows shown covered (see coveredRows), by index, with what each shows instead of its text. Nothing is covered when null or left out. */
  covers?: ReadonlyMap<number, string> | null;
  /** Extra controls rendered at the end of each hunk header row (e.g. stage/revert). */
  hunkActions?: (hunk: number) => ReactNode;
  /** With these, every line can be commented on and shows the comments that wait on it. Left out or null: a diff to read. */
  comments?: DiffComments | null;
  /** Long lines wrap inside the panel instead of scrolling sideways. */
  wrap?: boolean;
  className?: string;
}

const LINE_BG: Record<DiffRow['type'], string> = {
  add: 'bg-diff-add-bg',
  del: 'bg-diff-del-bg',
  ctx: '',
  hunk: 'bg-sunken text-fg-muted',
  note: 'text-fg-faint italic'
};

const SIGN: Record<DiffRow['type'], string> = { add: '+', del: '-', ctx: ' ', hunk: '', note: '' };

function Gutter({ value }: { value: number | null }) {
  return <span className="w-36 shrink-0 pr-6 text-right text-fg-faint select-none">{value ?? ''}</span>;
}

/**
 * The "+" in a line's gutter. It shows while the pointer is on the line or the keyboard on the button. A changed
 * line's button is in the tab order; an unchanged line's is for the pointer (the editor's command reaches every line).
 */
function CommentButton({ anchor, changed, onClick }: { anchor: CommentAnchor; changed: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Comment on line ${String(anchor.line)}`}
      tabIndex={changed ? 0 : -1}
      onClick={onClick}
      className="absolute inset-y-0 left-1 my-auto flex size-16 items-center justify-center rounded-xs bg-btn-primary text-btn-primary-fg opacity-0 transition-ui group-hover/line:opacity-100 hover:bg-btn-primary-hover focus-visible:opacity-100"
    >
      <Plus className="size-12" aria-hidden="true" />
    </button>
  );
}

/** Under a line: the comments that wait on it, and the box while one is being written. It keeps to the part of a wide diff that is in view. */
function LineComments({ comments, anchor, quote, writing, onClose }: { comments: DiffComments; anchor: CommentAnchor; quote: string; writing: boolean; onClose: () => void }) {
  const here = commentsAt(comments.list, anchor);
  if (here.length === 0 && !writing) return null;
  return (
    <div className="sticky left-0 flex w-[100cqw] flex-col gap-4 border-y border-border-subtle bg-sunken px-8 py-6">
      {here.map((comment) => (
        <CommentNote key={comment.id} comment={comment} onEdit={(text) => comments.onEdit(comment.id, text)} onDelete={() => comments.onDelete(comment.id)} />
      ))}
      {writing ? (
        <CommentBox
          onSave={(text) => {
            comments.onAdd({ ...anchor, quote }, text);
            onClose();
          }}
          onCancel={onClose}
        />
      ) : null}
    </div>
  );
}

function HunkRow({ row, actions }: { row: DiffRow; actions?: ReactNode }) {
  return (
    <div className={cn('flex min-h-20 items-center gap-8 pr-4 pl-8', LINE_BG[row.type])}>
      <span className="min-w-0 flex-1 truncate">{row.text}</span>
      {actions}
    </div>
  );
}

/** What a row's text is drawn with: its syntax tokens, once they are in, the words that changed in it, and its cover while it is covered. */
interface LineInk {
  tokens: Token[] | null;
  spans: Span[];
  cover: string | null;
}

const NO_INK: LineInk = { tokens: null, spans: [], cover: null };

/** Syntax tokens for every row: each hunk's two texts are highlighted whole and their tokens handed back to the rows they came from. */
function useRowTokens(rows: DiffRow[], language: string | null): Array<Token[] | null> {
  const themes = useCodeThemes();
  const sides = useMemo(() => hunkTexts(rows), [rows]);
  const [done, setDone] = useState<{ sides: typeof sides; language: string; lines: Array<{ before: Token[][] | null; after: Token[][] | null }> } | null>(null);
  useEffect(() => {
    if (language === null || sides.texts.length === 0) return;
    let cancelled = false;
    Promise.all(sides.texts.map(async (text) => ({ before: await highlightLines(text.before, language, themes), after: await highlightLines(text.after, language, themes) })))
      .then((lines) => {
        if (!cancelled) setDone({ sides, language, lines });
      })
      .catch((error: unknown) => logError('Syntax highlighting failed', error));
    return () => {
      cancelled = true;
    };
  }, [sides, language, themes]);
  return useMemo(() => {
    const lines = done && done.sides === sides && done.language === language ? done.lines : null;
    return sides.placeOf.map((at) => (at === null || lines === null ? null : (lines[at.hunk]?.[at.side]?.[at.line] ?? null)));
  }, [sides, done, language]);
}

function LineText({ text, ink, tone }: { text: string; ink: LineInk; tone: DiffRow['type'] }) {
  // Covered, a line is plain: colours and marks would outline the very thing that is hidden.
  if (ink.cover !== null) return <span title="Covered: this looks like a key, a token or a password">{ink.cover}</span>;
  if (text.length === 0) return <> </>;
  if (ink.tokens === null && ink.spans.length === 0) return <>{text}</>;
  const strong = tone === 'add' ? 'bg-diff-add-bg-strong' : tone === 'del' ? 'bg-diff-del-bg-strong' : '';
  return (
    <>
      {pieces(text, ink.tokens?.map((token) => token.content.length) ?? null, ink.spans).map((piece, i) => (
        <span key={i} className={cn(piece.token >= 0 && 'code-token', piece.changed && strong)} style={piece.token >= 0 ? ink.tokens?.[piece.token]?.style : undefined}>
          {piece.text}
        </span>
      ))}
    </>
  );
}

/** Unified or side-by-side diff; rows come from parsePatch / rowsFromHunks. */
export function DiffView({ rows, mode, language = null, gutter = 'both', hunkHeaders = true, covers = null, hunkActions, comments = null, wrap = false, className }: DiffViewProps) {
  /** The line a comment is being written on. */
  const [writing, setWriting] = useState<CommentAnchor | null>(null);
  const isWriting = (anchor: CommentAnchor): boolean => writing?.line === anchor.line && writing.side === anchor.side;
  // A comment goes to the model with its line quoted. A line that looks like a key or a password is never quoted, shown or not.
  const commenting = comments !== null;
  const secret = useMemo(() => (commenting ? coveredRows(rows) : null), [commenting, rows]);
  const place = useMemo(() => new Map(rows.map((row, i): [DiffRow, number] => [row, i])), [rows]);
  const quoteFor = (row: DiffRow): string => (secret?.has(place.get(row) ?? -1) ? '' : quoteOf(row.text));
  const spans = useMemo(() => inlineSpans(rows), [rows]);
  const tokens = useRowTokens(rows, language);
  // Rows are looked up by identity, so the side-by-side pairs find the same ink as the unified rows.
  const ink = useMemo(
    () => new Map(rows.map((row, i): [DiffRow, LineInk] => [row, { tokens: tokens[i] ?? null, spans: spans.get(i) ?? [], cover: covers?.get(i) ?? null }])),
    [rows, tokens, spans, covers]
  );
  const inkOf = (row: DiffRow): LineInk => ink.get(row) ?? NO_INK;

  if (rows.length === 0) return <p className="px-10 py-8 text-sm text-fg-muted">No textual changes.</p>;

  const header = (row: DiffRow, key: number): ReactNode => {
    if (row.type === 'note' || hunkHeaders) return <HunkRow key={key} row={row} actions={row.type === 'hunk' ? hunkActions?.(row.hunk) : undefined} />;
    // The first hunk needs nothing above it; later ones are set apart by a rule.
    return row.hunk > 0 ? <div key={key} role="separator" className="my-2 border-t border-dashed border-border" /> : null;
  };

  return (
    // With comments the diff is a size container: a comment under a line is as wide as the part in view, however long the lines are.
    <div className={cn('selectable overflow-x-auto font-mono text-[calc(var(--g-code-font-size)-1px)] leading-[1.55]', comments && '[container-type:inline-size]', className)}>
      <div className={wrap ? 'min-w-0' : 'min-w-max'}>
        {mode === 'unified'
          ? rows.map((row, i) => {
              if (row.type === 'hunk' || row.type === 'note') return header(row, i);
              const anchor = comments ? commentAnchor(row) : null;
              return (
                <Fragment key={i}>
                  <div data-find-block className={cn('flex', anchor && 'group/line relative', LINE_BG[row.type])}>
                    {anchor ? <CommentButton anchor={anchor} changed={row.type !== 'ctx'} onClick={() => setWriting(anchor)} /> : null}
                    {gutter === 'both' ? (
                      <>
                        <Gutter value={row.oldNo} />
                        <Gutter value={row.newNo} />
                      </>
                    ) : (
                      <Gutter value={row.type === 'del' ? row.oldNo : row.newNo} />
                    )}
                    <span className={cn('w-14 shrink-0 select-none', row.type === 'add' ? 'text-diff-add' : row.type === 'del' ? 'text-diff-del' : '')}>
                      {SIGN[row.type]}
                    </span>
                    <span className={cn('pr-12', wrap ? 'min-w-0 break-all whitespace-pre-wrap' : 'whitespace-pre')}>
                      <LineText text={row.text} ink={inkOf(row)} tone={row.type} />
                    </span>
                  </div>
                  {comments && anchor ? <LineComments comments={comments} anchor={anchor} quote={quoteFor(row)} writing={isWriting(anchor)} onClose={() => setWriting(null)} /> : null}
                </Fragment>
              );
            })
          : toSplitRows(rows).map((pair, i) => {
              if (pair.full) return header(pair.full, i);
              // A line that did not change is on both sides; it is commented on once, on the right.
              const sides = [pair.left, pair.right].map((side, j) => ({ side, anchor: comments && side && (j === 1 || side.type === 'del') ? commentAnchor(side) : null }));
              return (
                <Fragment key={i}>
                  <div className="grid grid-cols-2">
                    {sides.map(({ side, anchor }, j) => (
                      <div key={j} data-find-block className={cn('flex min-w-0', anchor && 'group/line relative', side ? LINE_BG[side.type] : 'bg-sunken', j === 0 && 'border-r border-border-subtle')}>
                        {side && anchor ? <CommentButton anchor={anchor} changed={side.type !== 'ctx'} onClick={() => setWriting(anchor)} /> : null}
                        <Gutter value={side ? (j === 0 ? side.oldNo : side.newNo) : null} />
                        <span className={cn('pr-12', wrap ? 'min-w-0 break-all whitespace-pre-wrap' : 'whitespace-pre')}>{side ? <LineText text={side.text} ink={inkOf(side)} tone={side.type} /> : ' '}</span>
                      </div>
                    ))}
                  </div>
                  {comments
                    ? sides.map(({ side, anchor }, j) =>
                        side && anchor ? <LineComments key={j} comments={comments} anchor={anchor} quote={quoteFor(side)} writing={isWriting(anchor)} onClose={() => setWriting(null)} /> : null
                      )
                    : null}
                </Fragment>
              );
            })}
      </div>
    </div>
  );
}
