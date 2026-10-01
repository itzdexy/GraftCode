import { useState } from 'react';
import { ChevronRight, CircleAlert } from 'lucide-react';
import { Ring } from '../../components/ContextRing';
import { cn } from '../../lib/cn';
import { ToolCallBody } from './ToolDetail';
import { describeCall, shellDescription, summarizeCalls, type ToolCall } from './transcriptModel';

function callFailed(call: ToolCall): boolean {
  const d = call.result?.display;
  if (d?.kind === 'shell') return d.timedOut || (d.exitCode !== null && d.exitCode !== 0);
  return call.result?.isError === true && d?.kind !== 'denied';
}

export function DiffCount({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null;
  return (
    <span className="shrink-0 font-mono text-xs" aria-label={`${String(added)} lines added, ${String(removed)} removed`}>
      <span className="text-diff-add">+{added}</span> <span className="text-diff-del">−{removed}</span>
    </span>
  );
}

export function CallRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(call.running !== null);
  const failed = callFailed(call);
  const edit = call.result?.display?.kind === 'edit' && !call.result.isError ? call.result.display : null;
  return (
    <li className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-h-24 items-center gap-6 rounded-sm px-4 text-left text-md text-fg-muted transition-ui hover:text-fg-secondary"
      >
        {call.running ? <Ring value={0} size={10} spinning label="Running" /> : failed ? <CircleAlert className="size-12 shrink-0 text-danger" aria-label="Failed" /> : null}
        <span className={cn('min-w-0 flex-1 truncate', call.name === 'Shell' && !shellDescription(call) && 'font-mono text-[calc(var(--g-code-font-size)-1px)]')}>
          {describeCall(call)}
        </span>
        {edit ? <DiffCount added={edit.added} removed={edit.removed} /> : null}
        <ChevronRight className={cn('size-14 shrink-0 transition-transform duration-[var(--g-duration-fast)]', open && 'rotate-90')} aria-hidden="true" />
      </button>
      {open ? (
        <div className="pt-2 pb-8 pl-4">
          <ToolCallBody call={call} />
        </div>
      ) : null}
    </li>
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
      {open ? (
        <ul className="mt-2 ml-5 flex flex-col gap-1 border-l border-border pl-10">
          {calls.map((call) => (
            <CallRow key={call.id} call={call} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
