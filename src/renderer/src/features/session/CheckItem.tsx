import { useState } from 'react';
import { CircleCheck, CircleX, ChevronRight, FlaskConical } from 'lucide-react';
import type { CheckReport } from '@shared/schemas/messages';
import { Spinner } from '../../components/ContextRing';
import { cn } from '../../lib/cn';
import { formatDuration } from '../../lib/format';
import { useShortcutLabel } from '../../lib/shortcuts';
import { useNow } from '../../lib/time';

/** The project's checks while they run, after the turn changed files. */
export function RunningChecks({ commands, round, startedAt }: { commands: string[]; round: number; startedAt: number }) {
  const now = useNow(1000);
  const stopKey = useShortcutLabel('interrupt');
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <div role="status" className="motion-rise flex items-center gap-8 rounded-md border border-border-card bg-sunken px-10 py-6">
      <Spinner size={12} label="Running checks" />
      <p className="min-w-0 flex-1 truncate text-md text-fg-secondary">
        {round > 1 ? 'Checking the fix' : 'Running checks'}
        <code className="ml-6 font-mono text-[calc(var(--g-code-font-size)-1px)] text-fg-muted">{commands.join(' · ')}</code>
      </p>
      <span className="shrink-0 text-xs text-fg-faint tabular-nums">
        {seconds}s · {stopKey} to stop
      </span>
    </div>
  );
}

/** The project's checks after a turn changed files: what ran, and what it said. */
export function CheckItem({ check }: { check: CheckReport }) {
  const firstFailure = check.runs.findIndex((r) => !r.passed);
  const [open, setOpen] = useState<number | null>(check.passed || firstFailure === -1 ? null : firstFailure);
  const failed = check.runs.filter((r) => !r.passed).length;
  const subject = check.runs.length === 1 ? 'check' : 'checks';
  const headline = check.passed ? `Checks passed` : `${failed} of ${check.runs.length} ${subject} failed`;
  const total = check.runs.reduce((sum, r) => sum + r.durationMs, 0);

  return (
    <div
      className={cn('overflow-hidden rounded-md border bg-sunken', check.passed ? 'border-border-card' : 'border-danger/40')}
      role="group"
      aria-label={`${headline} (round ${check.round})`}
    >
      <div className="flex items-center gap-8 px-10 py-6">
        {check.passed ? (
          <CircleCheck className="size-14 shrink-0 text-icon-muted" aria-hidden="true" />
        ) : (
          <CircleX className="size-14 shrink-0 text-danger" aria-hidden="true" />
        )}
        <FlaskConical className="size-14 shrink-0 text-icon-muted" aria-hidden="true" />
        <p className={cn('min-w-0 flex-1 truncate text-md font-medium', check.passed ? 'text-fg-secondary' : 'text-danger')}>{headline}</p>
        <span className="shrink-0 text-xs text-fg-faint tabular-nums">
          {formatDuration(total)}
          {check.round > 1 ? ` · after fix ${check.round - 1}` : ''}
        </span>
      </div>
      <ul className="border-t border-border-subtle">
        {check.runs.map((run, index) => {
          const showing = open === index;
          const why = run.timedOut ? 'Timed out' : run.exitCode === 0 ? 'Passed' : `Exit ${run.exitCode ?? '?'}`;
          return (
            <li key={index} className="border-b border-border-subtle last:border-b-0">
              <button
                type="button"
                aria-expanded={showing}
                onClick={() => setOpen(showing ? null : index)}
                className="flex w-full items-center gap-8 px-10 py-5 text-left hover:bg-raised"
              >
                <ChevronRight className={cn('size-12 shrink-0 text-icon-muted transition-ui', showing && 'rotate-90')} aria-hidden="true" />
                {run.passed ? (
                  <CircleCheck className="size-12 shrink-0 text-icon-muted" aria-hidden="true" />
                ) : (
                  <CircleX className="size-12 shrink-0 text-danger" aria-hidden="true" />
                )}
                <code className="selectable min-w-0 flex-1 truncate font-mono text-[calc(var(--g-code-font-size)-1px)] text-fg-secondary">
                  {run.command}
                </code>
                <span className={cn('shrink-0 text-xs tabular-nums', run.passed ? 'text-fg-faint' : 'text-danger')}>
                  {why} · {formatDuration(run.durationMs)}
                </span>
              </button>
              {showing ? (
                <pre className="selectable max-h-[320px] overflow-auto px-10 pt-2 pb-8 font-mono text-[calc(var(--g-code-font-size)-1px)] leading-[1.5] break-words whitespace-pre-wrap text-fg-secondary">
                  {run.output.length > 0 ? run.output : <span className="text-fg-faint">No output.</span>}
                </pre>
              ) : null}
            </li>
          );
        })}
      </ul>
      {check.runs.some((r) => r.truncated) ? <p className="px-10 py-5 text-xs text-fg-faint">Only the end of each output is kept here.</p> : null}
    </div>
  );
}
