import { useEffect, useState } from 'react';
import { ChevronRight, Layers } from 'lucide-react';
import type { AttemptSet } from '@shared/schemas/attempts';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Spinner } from '../../components/ContextRing';
import { Dialog, DialogContent } from '../../components/Dialog';
import { LoadingState } from '../../components/States';
import { cn } from '../../lib/cn';
import { formatTokenCount } from '../../lib/format';
import { invoke } from '../../lib/ipc';
import { useNow } from '../../lib/time';
import { reportError, useToasts } from '../../stores/toasts';
import { attemptRows, attemptsHeadline, sharedNotes, type AttemptRow } from './attemptsModel';
import { CheckItem } from './CheckItem';
import { useRewind } from './RewindDialog';
import { EditDiff } from './ToolDetail';
import { DiffCount } from './ToolGroup';

type Diff = { files: Array<{ path: string; patch: string; binary: boolean }>; truncated: boolean };

/** What one attempt changed, file by file, in the diff view the transcript uses for edits. */
function AttemptDiff({ sessionId, setId, row, onClose }: { sessionId: string; setId: string; row: AttemptRow; onClose: () => void }) {
  const [diff, setDiff] = useState<Diff | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    invoke('attempts:diff', { sessionId, setId, attempt: row.index })
      .then((value) => {
        if (!cancelled) setDiff(value);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, setId, row.index]);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        title={`Attempt ${String(row.index)} · ${row.model}`}
        description={`${row.files.count === 1 ? '1 file' : `${String(row.files.count)} files`} changed, +${String(row.files.added)} −${String(row.files.removed)}`}
        className="w-[min(880px,calc(100vw-48px))]"
      >
        {error !== null ? <p className="pb-12 text-md text-danger">{error}</p> : null}
        {diff === null && error === null ? <LoadingState label="Loading the diff…" /> : null}
        {diff ? (
          <div className="flex flex-col gap-8 pb-12">
            {diff.files.map((file) =>
              file.patch ? (
                <EditDiff key={file.path} patch={file.patch} path={file.path} />
              ) : (
                <p key={file.path} className="rounded-sm border border-border-card px-8 py-6 text-sm text-fg-muted">
                  <span className="font-mono text-fg-secondary">{file.path}</span>
                  {file.binary ? ': a binary file, not shown.' : ': too large to show here; its checkout holds it.'}
                </p>
              )
            )}
            {diff.truncated ? <p className="text-sm text-fg-muted">The diff is too large to show in full.</p> : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const TONES = { neutral: 'neutral', accent: 'accent', danger: 'danger', warning: 'warning' } as const;

function AttemptItem({ row, check, busy, onDiff, onApply, onStop }: {
  row: AttemptRow;
  check: AttemptSet['attempts'][number]['checks'];
  busy: boolean;
  onDiff: () => void;
  onApply: () => void;
  onStop: () => void;
}) {
  const [checksOpen, setChecksOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const name = `attempt ${String(row.index)}`;
  const working = row.state === 'Running' || row.state === 'Checking';
  return (
    <li className="flex flex-col gap-4 border-b border-border-subtle px-12 py-8 last:border-b-0" aria-label={`Attempt ${String(row.index)}, ${row.model}: ${row.state}`}>
      <div className="flex flex-wrap items-center gap-8">
        <span className="text-md font-medium text-fg">{`Attempt ${String(row.index)}`}</span>
        <span className="min-w-0 truncate text-sm text-fg-muted">{row.model}</span>
        <Badge tone={TONES[row.tone]} icon={working ? <Spinner size={10} label={row.state} /> : undefined}>
          {row.state}
        </Badge>
        <span className="flex-1" />
        {row.files.count > 0 ? (
          <span className="flex shrink-0 items-center gap-6 text-sm text-fg-secondary">
            {row.files.count === 1 ? '1 file' : `${String(row.files.count)} files`}
            <DiffCount added={row.files.added} removed={row.files.removed} pill />
          </span>
        ) : row.state === 'Done' || row.state === 'Applied' ? (
          <span className="shrink-0 text-sm text-fg-muted">No changes</span>
        ) : null}
      </div>
      {row.activity ? <p className="truncate text-sm text-fg-muted">{row.activity}</p> : null}
      {row.error ? <p className="selectable text-sm break-words text-danger">{row.error}</p> : null}
      <p className="flex flex-wrap items-center gap-x-10 gap-y-2 text-sm text-fg-muted tabular-nums">
        {row.checks ? (
          <button
            type="button"
            aria-expanded={checksOpen}
            onClick={() => setChecksOpen(!checksOpen)}
            className={cn('inline-flex items-center gap-2 rounded-xs hover:underline', row.checks.failed ? 'text-danger' : 'text-fg-secondary')}
          >
            <ChevronRight className={cn('size-12 transition-ui', checksOpen && 'rotate-90')} aria-hidden="true" />
            {row.checks.label}
          </button>
        ) : null}
        {row.tokens > 0 ? <span>{`${formatTokenCount(row.tokens)} tokens`}</span> : null}
        {row.cost ? <span>{row.cost}</span> : null}
        {row.time ? <span>{row.time}</span> : null}
      </p>
      {checksOpen && check ? <CheckItem check={check} /> : null}
      {row.notes.map((note) => (
        <p key={note} className="text-sm text-fg-muted">
          {note}
        </p>
      ))}
      {reportOpen && row.report ? <p className="selectable rounded-sm bg-sunken px-8 py-6 text-sm break-words whitespace-pre-wrap text-fg-secondary">{row.report}</p> : null}
      {row.canDiff || row.canApply || row.canStop || row.report ? (
        <div className="flex flex-wrap items-center gap-6">
          {row.canDiff ? (
            <Button size="xs" variant="secondary" aria-label={`View diff of ${name}`} onClick={onDiff}>
              View diff
            </Button>
          ) : null}
          {row.canApply ? (
            <Button size="xs" variant="primary" aria-label={`Apply ${name}`} disabled={busy} onClick={onApply}>
              Apply this one
            </Button>
          ) : null}
          {row.canStop ? (
            <Button size="xs" variant="ghost" aria-label={`Stop ${name}`} onClick={onStop}>
              Stop
            </Button>
          ) : null}
          {row.report && !working ? (
            <Button size="xs" variant="ghost" aria-expanded={reportOpen} aria-label={`${reportOpen ? 'Hide' : 'Show'} the report of ${name}`} onClick={() => setReportOpen(!reportOpen)}>
              {reportOpen ? 'Hide report' : 'Report'}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * The card of a message sent as attempts: one row per attempt with its model, state, the files it changed, its
 * checks, what it used and how long it took. A finished one opens in the diff view and can be applied; Stop stops
 * one or all while they run; Discard all removes every checkout. `busy`: a turn runs, so nothing is applied now.
 * `undo`: the attempts' message is the newest turn and has its snapshot, so an applied attempt can be taken back.
 */
export function AttemptsCard({ sessionId, set, busy, undo }: { sessionId: string; set: AttemptSet; busy: boolean; undo: boolean }) {
  const now = useNow(set.status === 'running' ? 1000 : 60_000);
  const [diffOf, setDiffOf] = useState<number | null>(null);
  const [acting, setActing] = useState(false);
  const rows = attemptRows(set, now);
  const shown = rows.find((row) => row.index === diffOf) ?? null;

  const act = async (title: string, work: () => Promise<void>): Promise<void> => {
    if (acting) return;
    setActing(true);
    try {
      await work();
    } catch (error) {
      reportError(title, error);
    } finally {
      setActing(false);
    }
  };
  const apply = (row: AttemptRow): Promise<void> =>
    act("Couldn't apply the attempt", async () => {
      const { files } = await invoke('attempts:apply', { sessionId, setId: set.id, attempt: row.index });
      useToasts.getState().push({ tone: 'success', title: `Applied attempt ${String(row.index)}`, description: `Changed ${files.length === 1 ? (files[0] ?? '1 file') : `${String(files.length)} files`}.` });
    });
  const discard = (): Promise<void> =>
    act("Couldn't discard the attempts", async () => {
      await invoke('attempts:discard', { sessionId, setId: set.id });
    });
  const stop = (attempt: number | null): void => {
    invoke('attempts:stop', { sessionId, setId: set.id, attempt }).catch((error: unknown) => reportError("Couldn't stop the attempt", error));
  };

  return (
    <section aria-label="Attempts" className="overflow-hidden rounded-md border border-border-card">
      <header className="flex min-h-30 flex-wrap items-center gap-8 border-b border-border-subtle px-12 py-4 text-md">
        <Layers className="size-13 shrink-0 text-icon" aria-hidden="true" />
        <span className="flex-1 font-medium text-fg-strong" aria-live="polite">
          {attemptsHeadline(set)}
        </span>
        {set.status === 'running' ? (
          <Button size="xs" variant="ghost" onClick={() => stop(null)}>
            Stop all
          </Button>
        ) : null}
        {set.status === 'open' ? (
          <Button size="xs" variant="ghost" disabled={acting} onClick={() => void discard()}>
            Discard all
          </Button>
        ) : null}
        {set.status === 'applied' && undo ? (
          <Button size="xs" variant="ghost" aria-label="Undo the applied attempt" onClick={() => useRewind.getState().open({ sessionId, messageId: set.messageId, chat: false, mode: 'files' })}>
            Undo
          </Button>
        ) : null}
      </header>
      {[...(set.note ? [set.note] : []), ...sharedNotes(set)].map((note) => (
        <p key={note} className="px-12 pt-8 text-sm text-fg-muted">
          {note}
        </p>
      ))}
      {set.status === 'open' && busy ? <p className="px-12 pt-8 text-sm text-fg-muted">Graft is working: an attempt can be applied once it stops.</p> : null}
      <ul aria-label="Attempts and how each went">
        {rows.map((row) => (
          <AttemptItem
            key={row.index}
            row={row}
            check={set.attempts[row.index - 1]?.checks ?? null}
            busy={busy || acting}
            onDiff={() => setDiffOf(row.index)}
            onApply={() => void apply(row)}
            onStop={() => stop(row.index)}
          />
        ))}
      </ul>
      {shown ? <AttemptDiff sessionId={sessionId} setId={set.id} row={shown} onClose={() => setDiffOf(null)} /> : null}
    </section>
  );
}
