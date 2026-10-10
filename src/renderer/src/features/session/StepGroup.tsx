import { useEffect, useState } from 'react';
import { ChevronRight, Globe } from 'lucide-react';
import { Mark } from '../../brand/Mark';
import { Collapse } from '../../components/Collapse';
import { cn } from '../../lib/cn';
import { formatTokenCount } from '../../lib/format';
import { subscribeVisibleClock } from '../../lib/motion';
import { SearchStep } from '../web/SearchResults';
import { RunningTasksLink } from './ThinkingIndicator';
import { CallRow, DiffCount } from './ToolGroup';
import { activityTitle, diffTotals, durationText, liveLabel, searchOfCall, type ActivityItem, type ActivityStep } from './transcriptModel';

/** How long the turn has run, counting up (paused while the window is hidden). Mounted only while a block is live, so finished blocks don't tick. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribeVisibleClock(() => setNow(Date.now())), []);
  return (
    <span className="shrink-0 text-sm text-fg-faint tabular-nums" aria-hidden="true">
      {durationText(Math.max(0, now - since))}
    </span>
  );
}

function Step({ step, live, verbose, boxed }: { step: ActivityStep; live: boolean; verbose: boolean; boxed: boolean }) {
  switch (step.kind) {
    case 'tool': {
      const call = step.call;
      if (call.name !== 'WebSearch') return <CallRow call={call} variant={boxed ? 'boxed' : 'flush'} defaultOpen={verbose} />;
      const failed = call.result?.isError ? call.result.content.map((c) => (c.type === 'text' ? c.text : '')).join(' ') : null;
      return (
        <div className={boxed ? 'px-6' : '-mx-4'}>
          <SearchStep search={searchOfCall(call)} live={call.running !== null || (call.result === null && live)} error={failed} />
        </div>
      );
    }
    case 'search':
      return (
        <div className={boxed ? 'px-6' : '-mx-4'}>
          <SearchStep search={step.search} live={step.search.results.length === 0 && live} />
        </div>
      );
    case 'provider':
      return (
        <p className={cn('flex items-center gap-6 text-md text-fg-muted', boxed ? 'min-h-30 px-10' : 'min-h-24')}>
          <Globe className="size-12 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate">{step.summary}</span>
        </p>
      );
    // What the agent says and thinks are lines of their own in these views, never steps.
    case 'text':
    case 'thinking':
      return null;
  }
}

/** A step that arrives while its block is working steps in; steps of a finished block are just there. */
function StepRow({ step, live, verbose }: { step: ActivityStep; live: boolean; verbose: boolean }) {
  const [arrived] = useState(live);
  return (
    <li className={cn('border-t border-border-subtle first:border-t-0', arrived && 'motion-step')}>
      <Step step={step} live={live} verbose={verbose} boxed />
    </li>
  );
}

/** What the line of a block at work says about its turn: the same as the status line under a turn. */
export interface TurnStatus {
  sessionId: string;
  /** When the turn started. A retry starts the clock again, though the turn's message is the old one. */
  startedAt: number | null;
  contextTokens: number;
  /** Whether the session has background commands to list. */
  tasks: boolean;
}

/**
 * The tool steps between two things the agent said, as one line that opens
 * into a list: "Read 2 files", "Created a file, edited 5 files +185 −9".
 * A single step is its own line. While the block is the newest of a running
 * turn, its line shows Scion, the step in progress, the turn's time so far,
 * the size of the context and the background commands still running, and
 * the list stays open.
 */
export function StepGroup({ item, verbose, turn }: { item: ActivityItem; verbose: boolean; turn: TurnStatus }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? (item.live || verbose);
  const only = item.steps.length === 1 ? item.steps[0] : undefined;

  if (only && !item.live) return <Step step={only} live={false} verbose={verbose} boxed={false} />;

  const calls = item.steps.flatMap((s) => (s.kind === 'tool' ? [s.call] : []));
  const diff = diffTotals(calls);
  const clock = turn.startedAt ?? item.startedAt;
  return (
    <section aria-label={item.live ? 'Work in progress' : 'Steps'} className="flex flex-col">
      {/* Beside the button, not inside it: a button's content is read as its name, not announced as a status. */}
      {item.live ? (
        <span role="status" className="sr-only">
          Graft is working
        </span>
      ) : null}
      <div className="flex max-w-full flex-wrap items-center gap-x-8 self-start">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setOpen(!expanded)}
          className={cn(
            'group flex min-h-26 min-w-0 items-center gap-8 rounded-sm text-left text-md transition-ui hover:text-fg-secondary',
            expanded && !item.live ? 'text-fg-secondary' : 'text-fg-muted'
          )}
        >
          {item.live ? (
            <>
              <Mark size={18} motion="thinking" />
              <span className="graft-shimmer min-w-0 truncate">{liveLabel(item)}</span>
              {clock === null ? null : <Elapsed since={clock} />}
              {turn.contextTokens > 0 ? (
                <span className="shrink-0 text-sm text-fg-faint" aria-hidden="true">
                  · {formatTokenCount(turn.contextTokens)} tokens
                </span>
              ) : null}
            </>
          ) : (
            <>
              <span className="min-w-0 truncate">{activityTitle(item)}</span>
              <DiffCount added={diff.added} removed={diff.removed} pill />
            </>
          )}
          <ChevronRight className={cn('size-14 shrink-0 transition-transform duration-[var(--g-duration-fast)]', expanded && 'rotate-90')} aria-hidden="true" />
        </button>
        {item.live && turn.tasks ? <RunningTasksLink sessionId={turn.sessionId} /> : null}
      </div>
      <Collapse open={expanded}>
        <ol className={cn('mt-4 overflow-hidden rounded-md border border-border-card', item.live && 'ml-26')}>
          {item.steps.map((step) => (
            <StepRow key={step.key} step={step} live={item.live} verbose={verbose} />
          ))}
        </ol>
      </Collapse>
    </section>
  );
}
