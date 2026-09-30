import { Button } from '../../components/Button';
import { Ring } from '../../components/ContextRing';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/Popover';
import { Tooltip } from '../../components/Tooltip';
import { formatTokenCount } from '../../lib/format';

interface ContextUsageProps {
  used: number;
  limit: number;
  /** When given, clicking opens details with a "Compact now" action. */
  onCompact?: () => void;
  compactDisabled?: boolean;
}

export function usageText(used: number, limit: number): string {
  if (limit <= 0) return 'Context size unknown';
  const pct = Math.min(100, Math.round((used / limit) * 100));
  return `${formatTokenCount(used)} of ${formatTokenCount(limit)} tokens used (${pct}%)`;
}

/** Circular context-window usage indicator for the composer row. */
export function ContextUsage({ used, limit, onCompact, compactDisabled = false }: ContextUsageProps) {
  const fraction = limit > 0 ? used / limit : 0;
  const text = usageText(used, limit);
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
        <p className="mt-10 text-sm text-fg-muted">
          Compacting summarizes the conversation so far and keeps the task, decisions and files in view. Graft also compacts
          automatically near the limit.
        </p>
        <Button size="sm" variant="secondary" className="mt-10" onClick={onCompact} disabled={compactDisabled}>
          Compact now
        </Button>
      </PopoverContent>
    </Popover>
  );
}
