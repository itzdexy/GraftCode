import { useState } from 'react';
import { SquareTerminal } from 'lucide-react';
import type { UserShell } from '@shared/schemas/messages';
import { Spinner } from '../../components/ContextRing';
import { cn } from '../../lib/cn';
import { formatDuration } from '../../lib/format';
import { useShortcutLabel } from '../../lib/shortcuts';
import { useNow } from '../../lib/time';

/** A "!" command while it runs: its elapsed time and how to stop it. */
export function RunningShell({ command, startedAt }: { command: string; startedAt: number | null }) {
  const now = useNow(1000);
  const stopKey = useShortcutLabel('interrupt');
  const seconds = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  return (
    <div role="status" className="motion-rise flex items-center gap-8 rounded-md border border-border-card bg-sunken px-10 py-6">
      <Spinner size={12} label="Running" />
      <code className="min-w-0 flex-1 truncate font-mono text-[calc(var(--g-code-font-size)-1px)] text-fg">
        <span className="text-accent">$</span> {command}
      </code>
      <span className="shrink-0 text-xs text-fg-faint tabular-nums">
        {seconds}s · {stopKey} to stop
      </span>
    </div>
  );
}

const FOLDED_LINES = 14;

/** A command the user ran with "!" and its output, drawn like a terminal. */
export function ShellItem({ shell }: { shell: UserShell }) {
  const lines = shell.output.length > 0 ? shell.output.split('\n') : [];
  const long = lines.length > FOLDED_LINES;
  const [open, setOpen] = useState(false);
  const failed = shell.timedOut || (!shell.interrupted && shell.exitCode !== 0);
  const status = shell.timedOut ? 'Timed out' : shell.interrupted ? 'Stopped' : shell.exitCode === 0 ? 'Done' : `Exit ${shell.exitCode ?? '?'}`;
  const shown = long && !open ? lines.slice(-FOLDED_LINES).join('\n') : shell.output;

  return (
    <div className="overflow-hidden rounded-md border border-border-card bg-sunken" aria-label={`You ran ${shell.command}`} role="group">
      <div className="flex items-center gap-8 border-b border-border-subtle px-10 py-6">
        <SquareTerminal className="size-14 shrink-0 text-icon-muted" aria-hidden="true" />
        <code className="selectable min-w-0 flex-1 truncate font-mono text-[calc(var(--g-code-font-size)-1px)] text-fg" title={`${shell.cwd}\n$ ${shell.command}`}>
          <span className="text-accent">$</span> {shell.command}
        </code>
        <span className={cn('shrink-0 text-xs tabular-nums', failed ? 'text-danger' : 'text-fg-faint')}>
          {status} · {formatDuration(shell.durationMs)}
        </span>
      </div>
      {long && !open ? (
        <button type="button" onClick={() => setOpen(true)} className="w-full px-10 pt-6 text-left text-xs text-link hover:underline">
          Show all {lines.length.toLocaleString()} lines
        </button>
      ) : null}
      <pre className="selectable max-h-[420px] overflow-auto px-10 py-8 font-mono text-[calc(var(--g-code-font-size)-1px)] leading-[1.5] break-words whitespace-pre-wrap text-fg-secondary">
        {shown.length > 0 ? shown : <span className="text-fg-faint">No output.</span>}
      </pre>
      {shell.truncated ? <p className="px-10 pb-6 text-xs text-fg-faint">Only the end of the output is kept here.</p> : null}
    </div>
  );
}
