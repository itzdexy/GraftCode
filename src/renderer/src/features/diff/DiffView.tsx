import { Fragment, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { toSplitRows, type DiffRow } from './diffModel';

interface DiffViewProps {
  rows: DiffRow[];
  mode: 'unified' | 'split';
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

/** Unified or side-by-side diff; rows come from parsePatch / rowsFromHunks. */
export function DiffView({ rows, mode, hunkActions, className }: DiffViewProps) {
  if (rows.length === 0) return <p className="px-10 py-8 text-sm text-fg-muted">No textual changes.</p>;
  return (
    <div className={cn('selectable overflow-x-auto font-mono text-[calc(var(--g-code-font-size)-1px)] leading-[1.55]', className)}>
      <div className="min-w-max">
        {mode === 'unified'
          ? rows.map((row, i) =>
              row.type === 'hunk' || row.type === 'note' ? (
                <HunkRow key={i} row={row} actions={row.type === 'hunk' ? hunkActions?.(row.hunk) : undefined} />
              ) : (
                <div key={i} className={cn('flex', LINE_BG[row.type])}>
                  <Gutter value={row.oldNo} />
                  <Gutter value={row.newNo} />
                  <span className={cn('w-14 shrink-0 select-none', row.type === 'add' ? 'text-diff-add' : row.type === 'del' ? 'text-diff-del' : '')}>
                    {SIGN[row.type]}
                  </span>
                  <span className="pr-12 whitespace-pre">{row.text || ' '}</span>
                </div>
              )
            )
          : toSplitRows(rows).map((pair, i) =>
              pair.full ? (
                <HunkRow key={i} row={pair.full} actions={pair.full.type === 'hunk' ? hunkActions?.(pair.full.hunk) : undefined} />
              ) : (
                <div key={i} className="grid grid-cols-2">
                  {[pair.left, pair.right].map((side, j) => (
                    <Fragment key={j}>
                      <div className={cn('flex min-w-0', side ? LINE_BG[side.type] : 'bg-sunken', j === 0 && 'border-r border-border-subtle')}>
                        <Gutter value={side ? (j === 0 ? side.oldNo : side.newNo) : null} />
                        <span className="pr-12 whitespace-pre">{side?.text || ' '}</span>
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
