import { useEffect, useState } from 'react';
import { Brain, ChevronRight, Globe } from 'lucide-react';
import { Mark } from '../../brand/Mark';
import { cn } from '../../lib/cn';
import { Markdown } from './Markdown';
import { CallRow, DiffCount } from './ToolGroup';
import { SearchStep } from '../web/SearchResults';
import { activityTitle, describeCall, diffTotals, durationText, searchOfCall, type ActivityItem, type ActivityStep } from './transcriptModel';

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="shrink-0 text-sm text-fg-faint tabular-nums">{durationText(now - since)}</span>;
}

/** What a running block is doing now: the running tool, else its newest step. */
function currentLabel(item: ActivityItem): string {
  for (let i = item.steps.length - 1; i >= 0; i--) {
    const step = item.steps[i];
    if (step?.kind === 'tool' && step.call.running) return step.call.running.summary || describeCall(step.call);
  }
  const last = item.steps.at(-1);
  if (!last) return 'Working';
  if (last.kind === 'text') return firstLine(last.text);
  if (last.kind === 'tool') return describeCall(last.call);
  if (last.kind === 'provider') return last.summary;
  if (last.kind === 'search') return `Searched the web for “${last.search.query}”`;
  return 'Thinking';
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.replace(/^#+\s*/, '').replace(/\*\*/g, '') ?? '';
}

function NarrationStep({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const line = firstLine(text);
  const more = text.trim() !== line;
  if (!more) return <p className="selectable px-4 py-2 text-md text-fg-secondary">{line}</p>;
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-h-24 items-center gap-6 rounded-sm px-4 text-left text-md text-fg-secondary transition-ui hover:text-fg"
      >
        <span className="min-w-0 flex-1 truncate">{line}</span>
        <ChevronRight className={cn('size-14 shrink-0 text-icon-muted transition-transform duration-[var(--g-duration-fast)]', open && 'rotate-90')} aria-hidden="true" />
      </button>
      {open ? <Markdown text={text} variant="code" className="px-4 pt-2 pb-6 text-fg-secondary" /> : null}
    </div>
  );
}

function ThoughtStep({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-h-24 items-center gap-6 rounded-sm px-4 text-left text-md text-fg-muted transition-ui hover:text-fg-secondary"
      >
        <Brain className="size-12 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{live ? 'Thinking' : 'Thought it through'}</span>
        <ChevronRight className={cn('size-14 shrink-0 transition-transform duration-[var(--g-duration-fast)]', open && 'rotate-90')} aria-hidden="true" />
      </button>
      {open ? <p className="selectable px-4 pt-2 pb-6 text-md whitespace-pre-wrap text-fg-muted">{text}</p> : null}
    </div>
  );
}

function Step({ step, live }: { step: ActivityStep; live: boolean }) {
  switch (step.kind) {
    case 'text':
      return <NarrationStep text={step.text} />;
    case 'thinking':
      return <ThoughtStep text={step.text} live={step.live} />;
    case 'tool': {
      const call = step.call;
      if (call.name !== 'WebSearch') return <CallRow call={call} />;
      const failed = call.result?.isError ? call.result.content.map((c) => (c.type === 'text' ? c.text : '')).join(' ') : null;
      return <SearchStep search={searchOfCall(call)} live={call.running !== null || (call.result === null && live)} error={failed} />;
    }
    case 'search':
      return <SearchStep search={step.search} live={step.search.results.length === 0 && live} />;
    case 'provider':
      return (
        <p className="flex min-h-24 items-center gap-6 px-4 text-md text-fg-muted">
          <Globe className="size-12 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate">{step.summary}</span>
        </p>
      );
  }
}

/**
 * A turn's work before its answer. While it runs, the header shows Scion,
 * the current step and the time so far, and the steps stay open; once done it
 * folds into one line, e.g. "Ran 4 commands, edited 2 files +75 −4 · 2m 13s".
 */
export function ActivityGroup({ item }: { item: ActivityItem }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? item.live;
  const calls = item.steps.flatMap((s) => (s.kind === 'tool' ? [s.call] : []));
  const diff = diffTotals(calls);
  const title = activityTitle(item);
  const duration = item.startedAt === null ? null : durationText(item.endedAt - item.startedAt);
  const timed = /^(Thought|Worked) for /.test(title);
  return (
    <section aria-label={item.live ? 'Work in progress' : 'Work done'} className="flex flex-col">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpen(!expanded)}
        className="group flex min-h-26 items-center gap-8 self-start rounded-sm text-left text-md text-fg-muted transition-ui hover:text-fg-secondary"
      >
        {item.live ? (
          <>
            <Mark size={16} motion="thinking" />
            <span className="graft-shimmer min-w-0 truncate">{currentLabel(item)}</span>
            {item.startedAt !== null ? <Elapsed since={item.startedAt} /> : null}
          </>
        ) : (
          <>
            <span className="min-w-0 truncate">{title}</span>
            <DiffCount added={diff.added} removed={diff.removed} />
            {duration !== null && !timed ? <span className="shrink-0 text-sm text-fg-faint">· {duration}</span> : null}
          </>
        )}
        <ChevronRight className={cn('size-14 shrink-0 transition-transform duration-[var(--g-duration-fast)]', expanded && 'rotate-90')} aria-hidden="true" />
      </button>
      {expanded ? (
        <ol className="graft-fade-in mt-2 ml-7 flex flex-col gap-1 border-l border-border pl-10">
          {item.steps.map((step) => (
            <li key={step.key}>
              <Step step={step} live={item.live} />
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
