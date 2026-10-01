import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, Maximize2, Minimize2, Square, Trash } from 'lucide-react';
import type { BackgroundShellView } from '@shared/schemas/panels';
import { Badge } from '../../components/Badge';
import { Button, IconButton } from '../../components/Button';
import { Ring } from '../../components/ContextRing';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { cn } from '../../lib/cn';
import { relativeTime } from '../../lib/format';
import { errorText, invoke } from '../../lib/ipc';
import { panelBus } from '../../stores/panels';
import { reportError } from '../../stores/toasts';
import { PanelFrame } from './PanelFrame';

const OUTPUT_POLL_MS = 1000;

function useShells(sessionId: string): { list: BackgroundShellView[] | null; error: string | null; reload: () => void } {
  const [list, setList] = useState<BackgroundShellView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => panelBus.onShellsChanged(sessionId, reload), [sessionId, reload]);
  useEffect(() => {
    let cancelled = false;
    invoke('shells:list', { sessionId })
      .then((shells) => {
        if (!cancelled) {
          setList([...shells].sort((a, b) => b.startedAt - a.startedAt));
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, tick]);
  return { list, error, reload };
}

function Output({ shell }: { shell: BackgroundShellView }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      invoke('shells:output', { id: shell.id })
        .then((r) => {
          if (!cancelled) setText(r.skipped > 0 ? `… ${r.skipped} earlier lines in ${shell.logPath}\n${r.output}` : r.output);
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(errorText(e));
        });
    };
    load();
    const timer = shell.status === 'running' ? setInterval(load, OUTPUT_POLL_MS) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [shell.id, shell.status, shell.logPath]);
  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (text === null) return <p className="text-sm text-fg-muted">Loading output…</p>;
  return (
    <pre className="selectable max-h-[240px] overflow-auto rounded-sm bg-code-block px-8 py-6 font-mono text-2xs leading-[1.5] whitespace-pre-wrap text-fg-secondary">
      {text || 'No output yet.'}
    </pre>
  );
}

function TaskRow({ shell }: { shell: BackgroundShellView }) {
  const [open, setOpen] = useState(false);
  const running = shell.status === 'running';
  const stop = (): void => {
    invoke('shells:kill', { id: shell.id }).catch((e: unknown) => reportError("Couldn't stop the command", e));
  };
  return (
    <li className="flex flex-col gap-4">
      <div className="flex min-h-26 items-center gap-6">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-6 text-left">
          {running ? <Ring value={0} size={10} spinning label="Running" /> : <ChevronRight className={cn('size-12 shrink-0 text-icon-muted transition-transform', open && 'rotate-90')} aria-hidden="true" />}
          <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg-secondary" title={shell.command}>
            {shell.command}
          </span>
        </button>
        {running ? (
          <Button size="xs" variant="ghost" onClick={stop} leading={<Square className="size-8 fill-current" strokeWidth={0} />}>
            Stop
          </Button>
        ) : (
          <Badge tone={shell.status === 'exited' && shell.exitCode === 0 ? 'neutral' : 'danger'}>
            {shell.status === 'killed' ? 'Stopped' : shell.status === 'failed' ? 'Failed' : `Exit ${shell.exitCode ?? '?'}`}
          </Badge>
        )}
      </div>
      <p className="pl-16 text-2xs text-fg-faint">
        {shell.id} · started {relativeTime(shell.startedAt)}
        {shell.endedAt ? ` · ended ${relativeTime(shell.endedAt)}` : ''}
      </p>
      {open || running ? (
        <div className="pl-16">
          <Output shell={shell} />
        </div>
      ) : null}
    </li>
  );
}

/** Background commands the agent started in this session: running ones live, finished ones grouped. */
export function TasksPanel({ sessionId, wide, onToggleWide, onClose }: { sessionId: string; wide: boolean; onToggleWide: () => void; onClose: () => void }) {
  const { list, error, reload } = useShells(sessionId);
  const [showFinished, setShowFinished] = useState(false);
  const running = list?.filter((s) => s.status === 'running') ?? [];
  const finished = list?.filter((s) => s.status !== 'running') ?? [];

  const clear = (): void => {
    invoke('shells:clear', { sessionId })
      .then(reload)
      .catch((e: unknown) => reportError("Couldn't clear finished commands", e));
  };

  return (
    <PanelFrame
      label="Background tasks"
      onClose={onClose}
      title="Background tasks"
      actions={
        <IconButton label={wide ? 'Narrow panel' : 'Widen panel'} size="xs" onClick={onToggleWide}>
          {wide ? <Minimize2 className="size-12" /> : <Maximize2 className="size-12" />}
        </IconButton>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-10 py-8">
        {list === null && !error ? <LoadingState /> : null}
        {error ? <ErrorState message={error} onRetry={reload} /> : null}
        {list && list.length === 0 ? <EmptyState title="No background tasks" description="Long-running commands the agent starts in the background show up here." /> : null}
        {running.length > 0 ? (
          <ul aria-label="Running" className="mb-8 flex flex-col gap-10">
            {running.map((s) => (
              <TaskRow key={s.id} shell={s} />
            ))}
          </ul>
        ) : null}
        {finished.length > 0 ? (
          <section aria-label="Finished">
            <div className="flex h-26 items-center gap-6">
              <button type="button" aria-expanded={showFinished} onClick={() => setShowFinished(!showFinished)} className="flex flex-1 items-center gap-6 text-base text-fg-muted hover:text-fg-secondary">
                Finished {finished.length}
                <ChevronRight className={cn('size-12 transition-transform', showFinished && 'rotate-90')} aria-hidden="true" />
              </button>
              <IconButton label="Clear finished" size="xs" onClick={clear}>
                <Trash className="size-14" />
              </IconButton>
            </div>
            {showFinished ? (
              <ul className="mt-4 flex flex-col gap-10">
                {finished.map((s) => (
                  <TaskRow key={s.id} shell={s} />
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
      </div>
    </PanelFrame>
  );
}
