import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ChangedProblems } from '@shared/schemas/semantic';
import { Button, IconButton } from '../../components/Button';
import { ErrorState, LoadingState } from '../../components/States';
import { cn } from '../../lib/cn';
import { errorText, invoke } from '../../lib/ipc';
import { usePanels } from '../../stores/panels';
import { useUi } from '../../stores/ui';
import { checkingLabel, fixRequest, problemCount, problemsMessage, withRequest } from './problemsModel';

/** The changed files a check looks at: what the language server reads, and still there. */
const CHECKED = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

type Done = { tick: number; key: unknown; result: ChangedProblems } | { tick: number; key: unknown; error: string };

/**
 * The errors and warnings in the files the session has changed, as the
 * language server reports them, in one list. Worked out when the tab opens
 * and on Refresh: a check can take a while, so it does not follow every turn.
 * A row opens its file at the problem. Files that could not be checked are
 * named with the reason, so an unanswered check never reads as a clean one.
 */
export function ProblemsView({ sessionId, refreshKey, onCount }: { sessionId: string; refreshKey: unknown; onCount: (count: number) => void }) {
  const [tick, setTick] = useState(0);
  const [done, setDone] = useState<Done | null>(null);
  /** How many changed files the running check looks at, once git has said; it words the wait. */
  const [looking, setLooking] = useState<{ tick: number; files: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    // The files as they were when this check began: a later turn changes `refreshKey`, and the list then says it is older.
    const key = refreshKey;
    invoke('git:status', { sessionId })
      .then((status) => {
        if (!cancelled) setLooking({ tick, files: status.files.filter((file) => CHECKED.test(file.path) && file.unstaged !== 'D' && !(file.unstaged === null && file.staged === 'D')).length });
      })
      .catch(() => undefined);
    invoke('problems:changed', { sessionId })
      .then((result) => {
        if (cancelled) return;
        setDone({ tick, key, result });
        onCount(problemCount(result));
      })
      .catch((error: unknown) => {
        if (!cancelled) setDone({ tick, key, error: errorText(error) });
      });
    return () => {
      cancelled = true;
    };
    // A check runs when the tab opens and on Refresh, not whenever the files change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, tick]);

  const current = done?.tick === tick ? done : null;
  const result = current && 'result' in current ? current.result : null;
  const count = problemCount(result);
  const message = result ? problemsMessage(result) : null;
  const waiting = checkingLabel(looking?.tick === tick ? looking.files : null);
  const ask = (): void => {
    if (!result) return;
    const ui = useUi.getState();
    ui.setDraft(sessionId, withRequest(ui.drafts[sessionId] ?? '', fixRequest(result.files)));
    ui.focusComposer?.();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-28 shrink-0 items-center gap-4 border-b border-border-panel pr-4 pl-10 text-sm text-fg-muted">
        <span className="min-w-0 flex-1 truncate">
          {current === null ? waiting : result && count > 0 ? `${String(count)} ${count === 1 ? 'problem' : 'problems'} in ${String(result.files.length)} changed ${result.files.length === 1 ? 'file' : 'files'}` : 'Problems in the changed files'}
        </span>
        <IconButton label="Refresh" size="xs" disabled={current === null} onClick={() => setTick((n) => n + 1)}>
          <RefreshCw className="size-12" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {current === null ? <LoadingState label={waiting} /> : null}
        {current && 'error' in current ? <ErrorState message={current.error} onRetry={() => setTick((n) => n + 1)} /> : null}
        {result ? (
          <>
            {current && current.key !== refreshKey ? <p className="px-10 pt-8 text-sm text-amber-fg">The files have changed since this check. Refresh to check again.</p> : null}
            {message !== null ? <p className="px-10 py-8 text-base text-fg-muted">{message}</p> : null}
            {result.files.map((file) => (
              <section key={file.path} aria-label={file.path} className="py-4">
                <h3 className="selectable truncate px-10 py-2 font-mono text-2xs text-fg-muted" title={file.path}>
                  {file.path}
                </h3>
                <ul>
                  {file.problems.map((problem, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        onClick={() => usePanels.getState().openFile(sessionId, file.path, { line: problem.line, column: problem.column })}
                        className="flex w-full items-baseline gap-8 px-10 py-4 text-left text-sm transition-ui hover:bg-hover"
                      >
                        <span role="img" aria-label={problem.severity === 'error' ? 'Error' : 'Warning'} className={cn('size-6 shrink-0 translate-y-[-1px] rounded-full', problem.severity === 'error' ? 'bg-danger' : 'bg-amber')} />
                        <span className="w-[52px] shrink-0 font-mono text-2xs text-fg-faint tabular-nums">
                          {problem.line}:{problem.column}
                        </span>
                        <span className="min-w-0 flex-1 break-words text-fg">
                          {problem.text}
                          {problem.code === null ? null : <span className="text-fg-faint"> ({problem.code})</span>}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {result.unchecked.length > 0 ? (
              <section aria-label="Not checked" className="border-t border-border-subtle py-6">
                <h3 className="px-10 py-2 text-xs font-medium text-fg-muted">Not checked</h3>
                <ul>
                  {result.unchecked.map((file) => (
                    <li key={file.path} className="flex items-baseline gap-8 px-10 py-2 text-sm">
                      <span className="selectable max-w-[55%] shrink-0 truncate font-mono text-2xs text-fg-secondary" title={file.path}>
                        {file.path}
                      </span>
                      <span className="min-w-0 flex-1 text-fg-muted">{file.reason}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : null}
      </div>
      {count > 0 ? (
        <div className="flex shrink-0 items-center justify-end border-t border-border-panel p-8">
          <Button size="sm" variant="secondary" onClick={ask} title="Writes the request into the message box. Nothing is sent until you send it.">
            Ask Graft to fix these
          </Button>
        </div>
      ) : null}
    </div>
  );
}
