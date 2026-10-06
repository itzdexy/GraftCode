import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Collapse } from '../../components/Collapse';
import { Ring } from '../../components/ContextRing';
import { cn } from '../../lib/cn';
import { ToolCallBody } from './ToolDetail';
import { callParts, summarizeCalls, type ToolCall } from './transcriptModel';

function callFailed(call: ToolCall): boolean {
  const d = call.result?.display;
  if (d?.kind === 'shell') return d.timedOut || (d.exitCode !== null && d.exitCode !== 0);
  return call.result?.isError === true && d?.kind !== 'denied';
}

/** Lines added and removed; `pill` gives each count its own tinted chip. */
export function DiffCount({ added, removed, pill = false }: { added: number; removed: number; pill?: boolean }) {
  if (added === 0 && removed === 0) return null;
  const label = `${String(added)} lines added, ${String(removed)} removed`;
  if (!pill) {
    return (
      <span className="shrink-0 font-mono text-xs" aria-label={label}>
        <span className="text-diff-add">+{added}</span> <span className="text-diff-del">−{removed}</span>
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-2 font-mono text-[11px] leading-none" aria-label={label}>
      <span className="rounded-xs bg-diff-add-bg px-4 py-2 text-diff-add">+{added}</span>
      <span className="rounded-xs bg-diff-del-bg px-4 py-2 text-diff-del">−{removed}</span>
    </span>
  );
}

/** One tool call as a step: what was done in muted text, what it was done to in strong text; opens to its details. */
export function CallRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(call.running !== null);
  const failed = callFailed(call);
  const declined = call.result?.display?.kind === 'denied';
  const edit = call.result?.display?.kind === 'edit' && !call.result.isError ? call.result.display : null;
  const parts = callParts(call);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        title={parts.title}
        onClick={() => setOpen(!open)}
        className="group/row flex min-h-24 items-center gap-6 rounded-sm px-4 text-left text-md text-fg-muted transition-ui hover:text-fg-secondary"
      >
        {call.running ? <Ring value={0} size={10} spinning label="Running" /> : null}
        <span className="min-w-0 truncate">
          {parts.verb}
          {parts.verb && parts.target ? ' ' : ''}
          {parts.target ? (
            <span className={cn('text-fg group-hover/row:text-fg-strong', parts.mono ? 'font-mono text-[calc(var(--g-code-font-size)-1px)]' : 'font-medium')}>{parts.target}</span>
          ) : null}
        </span>
        {edit ? <DiffCount added={edit.added} removed={edit.removed} pill /> : null}
        {failed ? <span className="shrink-0 text-danger">Failed</span> : declined ? <span className="shrink-0 text-amber-fg">Declined</span> : null}
        <ChevronRight className={cn('size-14 shrink-0 transition-transform duration-[var(--g-duration-fast)]', open && 'rotate-90')} aria-hidden="true" />
      </button>
      <Collapse open={open} className="pt-2 pb-8 pl-4">
        <ToolCallBody call={call} />
      </Collapse>
    </div>
  );
}

/** Consecutive tool calls folded into one muted, expandable summary line. */
export function ToolGroup({ calls }: { calls: ToolCall[] }) {
  const [open, setOpen] = useState(false);
  const running = calls.find((c) => c.running);
  const summary = summarizeCalls(calls);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group flex min-h-24 items-center gap-6 self-start rounded-sm text-left text-md text-fg-muted transition-ui hover:text-fg-secondary"
      >
        {running ? <Ring value={0} size={10} spinning label="Working" /> : null}
        <span className="min-w-0">{running && !open ? running.running?.summary || summary : summary}</span>
        <ChevronRight className={cn('size-14 shrink-0 transition-transform duration-[var(--g-duration-fast)]', open && 'rotate-90')} aria-hidden="true" />
      </button>
      <Collapse open={open}>
        <ul className="mt-2 ml-5 flex flex-col gap-1 border-l border-border pl-10">
          {calls.map((call) => (
            <li key={call.id}>
              <CallRow call={call} />
            </li>
          ))}
        </ul>
      </Collapse>
    </div>
  );
}
