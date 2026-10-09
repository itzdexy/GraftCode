import { useState, type ReactNode } from 'react';
import { ChevronRight, Square } from 'lucide-react';
import { agentRunActive, type AgentRun } from '@shared/schemas/agentRuns';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Collapse } from '../../components/Collapse';
import { cn } from '../../lib/cn';
import { formatDuration, formatTokenCount } from '../../lib/format';
import { invoke } from '../../lib/ipc';
import { usePanels } from '../../stores/panels';
import { reportError } from '../../stores/toasts';
import { Markdown } from '../session/Markdown';
import { AGENT_STATUS_LABEL, AgentStatusGlyph } from './AgentStatus';
import { clock, money, runDuration, runsNote } from './agentGraphLayout';

const OUTPUT = 'selectable max-h-[220px] overflow-auto rounded-sm bg-code-block px-8 py-6 font-mono text-2xs leading-[1.5] whitespace-pre-wrap text-fg-secondary';

/** A part of the inspector that folds away. It follows `open` until the user folds or unfolds it themselves. */
function Section({ title, count, open: fallback, children }: { title: string; count?: number; open: boolean; children: ReactNode }) {
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? fallback;
  return (
    <div className="flex flex-col border-t border-divider pt-4">
      <button type="button" aria-expanded={open} onClick={() => setChoice(!open)} className="flex h-24 items-center gap-6 text-left text-sm text-fg-tertiary transition-ui hover:text-fg">
        <ChevronRight className={cn('size-12 shrink-0 text-icon-muted transition-transform', open && 'rotate-90')} aria-hidden="true" />
        <span className="font-medium">{title}</span>
        {count !== undefined ? <span className="text-2xs text-fg-faint tabular-nums">{count}</span> : null}
      </button>
      <Collapse open={open} className="pt-2 pb-6 pl-18">
        {children}
      </Collapse>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-fg-secondary">{children}</dd>
    </>
  );
}

function statusLine(run: AgentRun): string {
  const label = AGENT_STATUS_LABEL[run.status];
  if (run.status === 'retrying') return `${label}: attempt ${String(run.attempt + 1)} of ${String(run.maxAttempts)} comes next`;
  return run.attempt > 1 ? `${label} · attempt ${String(run.attempt)} of ${String(run.maxAttempts)}` : label;
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m >= 1 ? `${String(m)} min` : `${String(Math.round(ms / 1000))} s`;
}

/**
 * Everything one agent of a group was given and did: its model and why, its
 * limits, what it used and changed, its check, its brief, its report, the
 * attempts that failed and the steps it took.
 */
export function AgentInspector({
  run,
  runs,
  now,
  sessionId,
  onSelect,
  className
}: {
  run: AgentRun;
  /** The agents of the same group, to name the ones this one waits for. */
  runs: AgentRun[];
  now: number;
  sessionId: string;
  onSelect: (runId: string) => void;
  className?: string;
}) {
  const active = agentRunActive(run.status);
  const duration = runDuration(run, now);
  const tokens = run.usage.inputTokens + run.usage.outputTokens;
  const used = Object.entries(run.toolsUsed).sort((a, b) => b[1] - a[1]);
  const waitsFor = run.dependsOn.flatMap((id) => runs.find((r) => r.nodeId === id) ?? []);
  const base = run.startedAt ?? run.createdAt;

  const stop = (): void => {
    invoke('sessions:stopAgent', { id: sessionId, runId: run.id }).catch((error: unknown) => reportError("Couldn't stop the agent", error));
  };

  return (
    <section aria-label={`Agent: ${run.title}`} className={cn('motion-rise flex min-w-0 flex-col gap-8 rounded-md border border-border-card bg-surface p-10', className)}>
      <header className="flex items-start gap-8">
        <div className="min-w-0 flex-1">
          <h3 className="selectable text-base font-medium text-fg">{run.title}</h3>
          <p className="mt-4 flex flex-wrap items-center gap-6 text-sm text-fg-muted">
            <Badge>{run.roleLabel}</Badge>
            <span className="inline-flex items-center gap-4">
              <AgentStatusGlyph status={run.status} />
              {statusLine(run)}
            </span>
          </p>
        </div>
        {active ? (
          <Button size="xs" variant="ghost" onClick={stop} leading={<Square className="size-8 fill-current" strokeWidth={0} />}>
            Stop
          </Button>
        ) : null}
      </header>

      {run.error && run.status !== 'done' ? (
        <p role={run.status === 'failed' ? 'alert' : undefined} className={cn('selectable rounded-sm px-8 py-6 text-sm whitespace-pre-wrap', run.status === 'failed' ? 'bg-danger-bg text-danger' : 'bg-control text-fg-secondary')}>
          {run.error}
        </p>
      ) : null}

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-12 gap-y-4 text-sm">
        <Fact label="Model">
          <span className="selectable">{run.model?.label ?? 'The session model'}</span>
          {run.routing.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-2 text-2xs text-fg-muted">
              {run.routing.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
          ) : null}
        </Fact>
        <Fact label="Time">
          <span className="tabular-nums">{duration === null ? 'Not started' : active ? clock(duration) : formatDuration(duration)}</span>
          <span className="text-fg-muted"> · stops at {minutes(run.budget.timeoutMs)}</span>
        </Fact>
        <Fact label="Tokens">
          <span className="tabular-nums">
            {tokens === 0 ? 'None yet' : `${formatTokenCount(run.usage.inputTokens)} in · ${formatTokenCount(run.usage.outputTokens)} out`}
            {run.usage.cacheReadTokens > 0 ? ` · ${formatTokenCount(run.usage.cacheReadTokens)} from cache` : ''}
          </span>
          {run.budget.maxTokens !== null ? <span className="text-fg-muted"> · budget {formatTokenCount(run.budget.maxTokens)}</span> : null}
        </Fact>
        <Fact label="Cost">
          <span className="tabular-nums">{run.costUsd !== null ? money(run.costUsd) : tokens > 0 ? 'This model has no published price' : 'Nothing yet'}</span>
        </Fact>
        <Fact label="Runs">{runsNote(run)}</Fact>
        {run.workspace ? <Fact label="Checkout">
          <p>{run.workspace.state === 'integrated' ? 'Changes integrated' : run.workspace.state === 'retained' ? 'Retained for review' : 'Private writer checkout'}</p>
          <p className="selectable break-all font-mono text-2xs">{run.workspace.path}</p>
          <p className="selectable break-all text-2xs">{run.workspace.branch}</p>
          {run.workspace.patchPath ? <p className="selectable break-all text-2xs">Patch: {run.workspace.patchPath}</p> : null}
        </Fact> : null}
        {run.writes.length > 0 ? (
          <Fact label="May change">
            <span className="flex flex-wrap gap-x-8 gap-y-2">
              {run.writes.map((path) => (
                <code key={path} className="selectable font-mono text-2xs break-all text-fg-secondary">
                  {path}
                </code>
              ))}
            </span>
          </Fact>
        ) : null}
        {waitsFor.length > 0 ? (
          <Fact label="After">
            <span className="flex flex-wrap gap-x-8 gap-y-2">
              {waitsFor.map((dep) => (
                <button key={dep.id} type="button" onClick={() => onSelect(dep.id)} className="max-w-full truncate text-link hover:underline" title="Show this agent">
                  {dep.title}
                </button>
              ))}
            </span>
          </Fact>
        ) : null}
      </dl>

      {run.verify ? (
        <Section title="Check" open>
          <div className="flex flex-col gap-4">
            <code className="selectable font-mono text-2xs break-all text-fg-secondary">{run.verify.command}</code>
            <p className={cn('text-sm', run.verify.passed === null ? 'text-fg-muted' : run.verify.passed ? 'text-success' : 'text-danger')}>
              {run.verify.passed === null
                ? 'Runs when the agent reports. Its work only counts once this passes.'
                : run.verify.passed
                  ? `Passed${run.verify.rounds > 1 ? ` on round ${String(run.verify.rounds)}` : ''}`
                  : `Failed on round ${String(run.verify.rounds)}`}
            </p>
            {run.verify.output ? <pre className={OUTPUT}>{run.verify.output}</pre> : null}
          </div>
        </Section>
      ) : null}

      {run.retries.length > 0 ? (
        <Section title="Failed attempts" count={run.retries.length} open>
          <ol className="flex flex-col gap-4 text-sm">
            {run.retries.map((retry) => (
              <li key={retry.attempt} className="selectable text-fg-secondary">
                <span className="text-amber-fg">Attempt {retry.attempt}</span>
                <span className="text-fg-faint tabular-nums"> · {clock(Math.max(0, retry.at - base))} in</span>
                <span className="block whitespace-pre-wrap">{retry.error}</span>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      <Section title="Tools" count={run.toolCalls} open={used.length > 0 && used.length <= 8}>
        <div className="flex flex-col gap-6">
          {used.length > 0 ? (
            <ul aria-label="Tools it used" className="flex flex-wrap gap-4">
              {used.map(([name, count]) => (
                <li key={name}>
                  <Badge>
                    {name}
                    {count > 1 ? <span className="text-fg-faint tabular-nums">×{count}</span> : null}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-fg-muted">It hasn't used a tool.</p>
          )}
          <p className="selectable text-2xs text-fg-faint">May use: {run.tools.length > 0 ? run.tools.join(', ') : 'no tools'}</p>
        </div>
      </Section>

      {run.filesChanged.length > 0 ? (
        <Section title="Files changed" count={run.filesChanged.length} open>
          <ul className="flex flex-col gap-2">
            {run.filesChanged.map((file) => (
              <li key={file} className="selectable truncate font-mono text-2xs text-fg-secondary" title={file}>
                {file}
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => usePanels.getState().show(sessionId, 'changes')} className="mt-4 text-sm text-link hover:underline">
            Review the changes
          </button>
        </Section>
      ) : null}

      <Section title="Brief" open={false}>
        <p className="selectable text-sm whitespace-pre-wrap text-fg-secondary">{run.prompt}</p>
        <p className="mt-6 text-2xs text-fg-faint">
          It starts with a fresh context: this brief{waitsFor.length > 0 ? `, the ${waitsFor.length === 1 ? 'report' : 'reports'} of the ${waitsFor.length === 1 ? 'agent' : 'agents'} it waits for,` : ''} and nothing of the conversation.
        </p>
      </Section>

      {run.result ? (
        <Section title="Report" open>
          <Markdown text={run.result} variant="code" />
        </Section>
      ) : null}

      <Section title="Steps" count={run.timeline.length} open={active}>
        {run.timeline.length > 0 ? (
          <ol className="flex flex-col gap-2">
            {run.timeline.map((entry, i) => (
              <li key={i} className="flex gap-8 text-sm">
                <span className="w-32 shrink-0 text-right text-2xs leading-[18px] text-fg-faint tabular-nums">{clock(Math.max(0, entry.at - base))}</span>
                <span className={cn('selectable min-w-0 flex-1 break-words', entry.kind === 'retry' ? 'text-amber-fg' : entry.kind === 'tool' ? 'text-fg-secondary' : 'text-fg')}>{entry.text}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-fg-muted">Nothing yet.</p>
        )}
      </Section>
    </section>
  );
}
