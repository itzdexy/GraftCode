import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Ring } from '../../components/ContextRing';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/Popover';
import { Tooltip } from '../../components/Tooltip';
import type { ContextReport, SessionUsage } from '@shared/schemas/sessions';
import { formatTokenCount } from '../../lib/format';
import { partBars } from './contextModel';

interface ContextUsageProps {
  used: number;
  limit: number;
  /** When given, clicking opens details with a "Compact now" action. */
  onCompact?: () => void;
  compactDisabled?: boolean;
  /** Tokens and spend so far, shown in the details. */
  session?: SessionUsage;
  /** Works out what fills the context; when given, the details show it part by part. */
  loadParts?: () => Promise<ContextReport>;
}

/**
 * The window a session is measured against: the selected model's, since the
 * next request goes to it. The limit recorded at the last turn may be another
 * model's, or a size since corrected; it stands in only until the model list
 * has loaded.
 */
export function contextLimit(recorded: number, model: { contextWindow: number } | null | undefined): number {
  return model?.contextWindow || recorded;
}

export function usageText(used: number, limit: number): string {
  if (limit <= 0) return 'Context size unknown';
  const pct = Math.min(100, Math.round((used / limit) * 100));
  return `${formatTokenCount(used)} of ${formatTokenCount(limit)} tokens used (${pct}%)`;
}

/** What a session has sent, generated and cost so far; null before the first response. */
export function spendText(usage: SessionUsage): { tokens: string; cost: string } | null {
  const t = usage.totals;
  const sent = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
  if (sent + t.outputTokens === 0) return null;
  const cached = t.cacheReadTokens > 0 ? ` (${Math.round((t.cacheReadTokens / sent) * 100)}% from cache)` : '';
  return {
    tokens: `${formatTokenCount(sent)} input${cached} · ${formatTokenCount(t.outputTokens)} output`,
    cost:
      usage.costUsd === null
        ? 'No published prices for this model'
        : usage.costUsd < 0.01
          ? 'Less than $0.01'
          : `About $${usage.costUsd.toFixed(2)}`
  };
}

/**
 * The parts of the context, as bars. It is mounted when the popover opens, so the parts are
 * worked out again each time: they change with every step of a turn.
 */
function WhatFillsIt({ load }: { load: () => Promise<ContextReport> }) {
  const [state, setState] = useState<{ status: 'loading' | 'failed' } | { status: 'ready'; report: ContextReport }>({ status: 'loading' });
  // The loader is a new function on every render of the session; only the one at opening is used.
  const loader = useRef(load);
  useEffect(() => {
    let shown = true;
    loader.current().then(
      (report) => {
        if (shown) setState({ status: 'ready', report });
      },
      () => {
        if (shown) setState({ status: 'failed' });
      }
    );
    return () => {
      shown = false;
    };
  }, []);
  return (
    <>
      <p className="mt-12 text-base font-medium text-fg-strong">What fills it</p>
      {state.status === 'loading' ? (
        <p role="status" className="mt-4 text-sm text-fg-muted">
          Working it out…
        </p>
      ) : null}
      {state.status === 'failed' ? (
        <p role="alert" className="mt-4 text-sm text-fg-muted">
          Couldn't work it out.
        </p>
      ) : null}
      {state.status === 'ready' ? (
        <>
          <div className="mt-6 flex flex-col gap-6">
            {partBars(state.report.parts).map((bar) => (
              <div key={bar.id} role="img" aria-label={`${bar.label}: ${bar.tokens} tokens`}>
                <div className="flex items-baseline justify-between gap-8 text-sm">
                  <span className="min-w-0 truncate text-fg-secondary">{bar.label}</span>
                  <span className="shrink-0 text-fg-muted tabular-nums">{bar.tokens}</span>
                </div>
                <div className="mt-2 h-4 overflow-hidden rounded-full bg-control">
                  <div className="h-full rounded-full bg-blue" style={{ width: `${String(bar.share * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-6 text-sm text-fg-muted">Estimated from the text.</p>
        </>
      ) : null}
    </>
  );
}

/** Circular context-window usage indicator for the composer row. */
export function ContextUsage({ used, limit, onCompact, compactDisabled = false, session, loadParts }: ContextUsageProps) {
  const fraction = limit > 0 ? used / limit : 0;
  const text = usageText(used, limit);
  const spend = session ? spendText(session) : null;
  const ring = <Ring value={fraction} size={12} stroke={1.5} />;
  if (!onCompact) {
    return (
      <Tooltip content={`Context: ${text}`} side="top">
        <span role="img" aria-label={`Context: ${text}`} tabIndex={0} className="inline-flex size-22 items-center justify-center rounded-md">
          {ring}
        </span>
      </Tooltip>
    );
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Context: ${text}`}
          className="inline-flex size-22 items-center justify-center rounded-md transition-ui hover:bg-hover data-[state=open]:bg-hover"
        >
          {ring}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[260px] p-12">
        <p className="text-base font-medium text-fg-strong">Context window</p>
        <p className="mt-4 text-sm text-fg-muted">{text}</p>
        <div className="mt-8 h-4 overflow-hidden rounded-full bg-control" aria-hidden="true">
          <div className="h-full rounded-full bg-blue" style={{ width: `${Math.min(100, Math.round(fraction * 100))}%` }} />
        </div>
        {loadParts ? <WhatFillsIt load={loadParts} /> : null}
        {spend ? (
          <>
            <p className="mt-12 text-base font-medium text-fg-strong">This session</p>
            <p className="mt-4 text-sm text-fg-muted">{spend.tokens}</p>
            <p className="mt-2 text-sm text-fg-muted">{spend.cost}</p>
          </>
        ) : null}
        <p className="mt-10 text-sm text-fg-muted">
          Compacting summarizes the conversation so far and keeps the task, decisions, files and latest steps in view. Near the
          limit Graft makes room itself: old tool output goes first.
        </p>
        <Button size="sm" variant="secondary" className="mt-10" onClick={onCompact} disabled={compactDisabled}>
          Compact now
        </Button>
      </PopoverContent>
    </Popover>
  );
}
