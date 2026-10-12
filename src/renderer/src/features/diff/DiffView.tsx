import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { highlightLines, type Token } from '../../lib/highlight';
import { logError } from '../../lib/log';
import { hunkTexts, inlineSpans, pieces, toSplitRows, type DiffRow, type Span } from './diffModel';

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
  const sides = useMemo(() => hunkTexts(rows), [rows]);
  const [done, setDone] = useState<{ sides: typeof sides; language: string; lines: Array<{ before: Token[][] | null; after: Token[][] | null }> } | null>(null);
  useEffect(() => {
    if (language === null || sides.texts.length === 0) return;
    let cancelled = false;
    Promise.all(sides.texts.map(async (text) => ({ before: await highlightLines(text.before, language), after: await highlightLines(text.after, language) })))
      .then((lines) => {
        if (!cancelled) setDone({ sides, language, lines });
      })
      .catch((error: unknown) => logError('Syntax highlighting failed', error));
    return () => {
      cancelled = true;
    };
  }, [sides, language]);
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
export function DiffView({ rows, mode, language = null, gutter = 'both', hunkHeaders = true, covers = null, hunkActions, className }: DiffViewProps) {
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
    <div className={cn('selectable overflow-x-auto font-mono text-[calc(var(--g-code-font-size)-1px)] leading-[1.55]', className)}>
      <div className="min-w-max">
        {mode === 'unified'
          ? rows.map((row, i) =>
              row.type === 'hunk' || row.type === 'note' ? (
                header(row, i)
              ) : (
                <div key={i} data-find-block className={cn('flex', LINE_BG[row.type])}>
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
                  <span className="pr-12 whitespace-pre">
                    <LineText text={row.text} ink={inkOf(row)} tone={row.type} />
                  </span>
                </div>
              )
            )
          : toSplitRows(rows).map((pair, i) =>
              pair.full ? (
                header(pair.full, i)
              ) : (
                <div key={i} className="grid grid-cols-2">
                  {[pair.left, pair.right].map((side, j) => (
                    <Fragment key={j}>
                      <div data-find-block className={cn('flex min-w-0', side ? LINE_BG[side.type] : 'bg-sunken', j === 0 && 'border-r border-border-subtle')}>
                        <Gutter value={side ? (j === 0 ? side.oldNo : side.newNo) : null} />
                        <span className="pr-12 whitespace-pre">{side ? <LineText text={side.text} ink={inkOf(side)} tone={side.type} /> : ' '}</span>
                      </div>
                    </Fragment>
                  ))}
                </div>
              )
            )}
      </div>
    </div>
  );
}
