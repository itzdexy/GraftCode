import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, Workflow } from 'lucide-react';
import type { AgentRun } from '@shared/schemas/agentRuns';
import { IconButton } from '../../components/Button';
import { EmptyState } from '../../components/States';
import { cn } from '../../lib/cn';
import { formatDuration, formatTokenCount } from '../../lib/format';
import { useSessions, viewOf } from '../../stores/sessions';
import { AgentInspector } from './AgentInspector';
import { AGENT_STATUS_LABEL, AgentStatusGlyph } from './AgentStatus';
import { clock, groupElapsed, groupsOf, groupTotals, layoutAgentGraph, money, NODE_HEIGHT, pickAgent, runDuration, type AgentBox, type AgentGroup } from './agentGraphLayout';
import { PanelFrame } from './PanelFrame';

/** From this width the graph and the inspector sit side by side. */
const SPLIT_WIDTH = 760;
const INSPECTOR_WIDTH = 360;
const PAD = 12;

/** The time now, moving once a second while something is running (for the running times). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** An element's width, read when it mounts and again whenever it changes. */
function useWidth(): [(el: HTMLElement | null) => void, number] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const subscribe = useCallback(
    (changed: () => void) => {
      if (!el) return () => undefined;
      const observer = new ResizeObserver(changed);
      observer.observe(el);
      return () => observer.disconnect();
    },
    [el]
  );
  const width = useSyncExternalStore(subscribe, () => el?.clientWidth ?? 0);
  return [setEl, width];
}

/** The second line of an agent in the graph: how far along it is. */
function progressText(run: AgentRun, now: number): string {
  const duration = runDuration(run, now);
  switch (run.status) {
    case 'running':
      return clock(duration ?? 0);
    case 'retrying':
      return `Retry ${String(run.attempt + 1)}/${String(run.maxAttempts)}`;
    case 'done':
      return duration === null ? AGENT_STATUS_LABEL.done : formatDuration(duration);
    default:
      return AGENT_STATUS_LABEL[run.status];
  }
}

const NODE_TONE: Record<AgentRun['status'], string> = {
  queued: 'border-dashed border-border-strong',
  running: 'border-blue',
  retrying: 'border-amber',
  done: 'border-border-card',
  failed: 'border-danger',
  skipped: 'border-dashed border-border-card opacity-70',
  cancelled: 'border-dashed border-border-card opacity-70'
};

function AgentNode({ box, step, selected, now, onSelect }: { box: AgentBox; step: number; selected: boolean; now: number; onSelect: () => void }) {
  const { run } = box;
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${run.title}: ${run.roleLabel}, ${AGENT_STATUS_LABEL[run.status].toLowerCase()}`}
      title={run.title}
      onClick={onSelect}
      data-status={run.status}
      style={{ left: box.x, top: box.y, width: box.width, height: NODE_HEIGHT, animationDelay: `${String(Math.min(step, 6) * 45)}ms` }}
      className={cn('motion-rise pressable absolute flex flex-col justify-center gap-3 rounded-md border px-8 text-left transition-ui', NODE_TONE[run.status], selected ? 'bg-selected' : 'bg-surface hover:bg-hover')}
    >
      <span className="flex min-w-0 items-start gap-6">
        <span className="flex h-16 shrink-0 items-center">
          <AgentStatusGlyph status={run.status} />
        </span>
        <span className="line-clamp-2 min-w-0 flex-1 text-sm leading-[16px] text-fg">{run.title}</span>
      </span>
      {/* How far along comes first: in a narrow agent it is the part that must stay readable. */}
      <span className="truncate pl-18 text-2xs text-fg-muted tabular-nums">
        {progressText(run, now)} · {run.roleLabel}
      </span>
    </button>
  );
}

/** One group as a graph: steps run top to bottom, agents of a step side by side, a line to everything an agent waits for. */
function AgentGraph({ runs, width, selectedId, now, onSelect }: { runs: AgentRun[]; width: number; selectedId: string | null; now: number; onSelect: (runId: string) => void }) {
  const layout = useMemo(() => layoutAgentGraph(runs, width), [runs, width]);
  const statusOf = new Map(runs.map((r) => [r.nodeId, r.status]));
  // The step of each agent, to stagger how the graph appears: rows share a y.
  const rows = [...new Set(layout.nodes.map((n) => n.y))].sort((a, b) => a - b);
  return (
    <div role="group" aria-label="Agent graph" className="relative" style={{ height: layout.height }}>
      <svg className="pointer-events-none absolute top-0 left-0" width={layout.width} height={layout.height} aria-hidden="true">
        {layout.edges.map((edge) => {
          const target = statusOf.get(edge.to);
          const flowing = edge.settled && (target === 'running' || target === 'retrying');
          return <path key={`${edge.from}>${edge.to}`} d={edge.path} className={cn('agent-edge', edge.settled && 'agent-edge--settled', flowing && 'agent-edge--flowing')} />;
        })}
      </svg>
      {layout.nodes.map((box) => (
        <AgentNode key={box.run.id} box={box} step={rows.indexOf(box.y)} selected={box.run.id === selectedId} now={now} onSelect={() => onSelect(box.run.id)} />
      ))}
    </div>
  );
}

function GroupHeader({ group, now }: { group: AgentGroup; now: number }) {
  const totals = groupTotals(group.runs);
  const elapsed = groupElapsed(group.runs, now);
  const working = group.runs.filter((r) => r.status === 'running' || r.status === 'retrying').length;
  const other = totals.total - totals.done - totals.failed - totals.active;
  const facts = [
    `${String(totals.done)} of ${String(totals.total)} done`,
    working > 0 ? `${String(working)} working` : '',
    totals.active - working > 0 ? `${String(totals.active - working)} waiting` : '',
    totals.failed > 0 ? `${String(totals.failed)} failed` : '',
    other > 0 ? `${String(other)} didn't run` : '',
    totals.tokens > 0 ? `${formatTokenCount(totals.tokens)} tokens` : '',
    totals.costUsd !== null && totals.costUsd > 0 ? money(totals.costUsd) : '',
    elapsed !== null ? (totals.active > 0 ? clock(elapsed) : formatDuration(elapsed)) : ''
  ].filter(Boolean);
  const share = (n: number): string => `${String((n / Math.max(1, totals.total)) * 100)}%`;
  return (
    <div className="flex flex-col gap-6">
      <p className="selectable line-clamp-3 text-base text-fg" title={group.goal}>
        {group.goal}
      </p>
      <div className="flex h-3 overflow-hidden rounded-full bg-control" role="progressbar" aria-label="Agents finished" aria-valuemin={0} aria-valuemax={totals.total} aria-valuenow={totals.total - totals.active}>
        <div className="h-full bg-success transition-[width] duration-300" style={{ width: share(totals.done) }} />
        <div className="h-full bg-danger transition-[width] duration-300" style={{ width: share(totals.failed) }} />
        <div className="h-full bg-strong transition-[width] duration-300" style={{ width: share(other) }} />
      </div>
      <p className="text-2xs text-fg-muted tabular-nums">{facts.join(' · ')}</p>
    </div>
  );
}

/**
 * The groups of agents this session ran (RunAgents): each as a graph that
 * updates while it runs, with everything about the agent you pick.
 */
export function AgentsPanel({ sessionId, wide, onToggleWide, onClose }: { sessionId: string; wide: boolean; onToggleWide: () => void; onClose: () => void }) {
  const runs = useSessions((s) => viewOf(s, sessionId).agentRuns);
  const groups = useMemo(() => groupsOf(runs), [runs]);
  const [pickedGroup, setPickedGroup] = useState<string | null>(null);
  const [pickedRun, setPickedRun] = useState<string | null>(null);
  // A group that starts takes the panel: it is what the session is doing now.
  const [seenGroups, setSeenGroups] = useState(groups.length);
  if (groups.length !== seenGroups) {
    setSeenGroups(groups.length);
    if (groups.length > seenGroups) {
      setPickedGroup(null);
      setPickedRun(null);
    }
  }
  const [setBody, bodyWidth] = useWidth();
  // The newest group unless an earlier one was picked.
  const picked = groups.findIndex((g) => g.id === pickedGroup);
  const shownIndex = picked === -1 ? groups.length - 1 : picked;
  const group = groups[shownIndex] ?? null;
  const now = useNow((group?.active ?? 0) > 0);
  const selected = group ? (group.runs.find((r) => r.id === pickedRun) ?? pickAgent(group.runs)) : null;

  const inner = Math.max(0, bodyWidth - PAD * 2);
  const split = inner >= SPLIT_WIDTH;
  const graphWidth = split ? inner - INSPECTOR_WIDTH - PAD : inner;
  const go = (to: number): void => {
    const next = groups[to];
    if (!next) return;
    setPickedGroup(next.id);
    setPickedRun(null);
  };

  return (
    <PanelFrame
      label="Agents"
      onClose={onClose}
      title={
        <>
          <span>Agents</span>
          {groups.length > 1 ? (
            <span className="flex items-center gap-2 text-2xs text-fg-muted tabular-nums">
              <IconButton label="Earlier group" size="xs" disabled={shownIndex <= 0} onClick={() => go(shownIndex - 1)}>
                <ChevronLeft className="size-12" />
              </IconButton>
              {shownIndex + 1} of {groups.length}
              <IconButton label="Later group" size="xs" disabled={shownIndex >= groups.length - 1} onClick={() => go(shownIndex + 1)}>
                <ChevronRight className="size-12" />
              </IconButton>
            </span>
          ) : null}
        </>
      }
      actions={
        <IconButton label={wide ? 'Narrow panel' : 'Widen panel'} size="xs" onClick={onToggleWide}>
          {wide ? <Minimize2 className="size-12" /> : <Maximize2 className="size-12" />}
        </IconButton>
      }
    >
      <div ref={setBody} className="min-h-0 flex-1 overflow-y-auto">
        {group === null ? (
          <EmptyState
            icon={<Workflow className="size-20" />}
            title="No agents yet"
            description="When a task splits up, Graft can run it as a group of agents: explorers side by side, then an implementer, a tester and reviewers. Ask for it (“use a group of agents”) and the group shows up here as a graph."
          />
        ) : (
          <div className={cn('flex gap-12 p-12', split ? 'flex-row items-start' : 'flex-col')}>
            <div className="flex min-w-0 flex-1 flex-col gap-12">
              <GroupHeader group={group} now={now} />
              {graphWidth > 0 ? <AgentGraph key={group.id} runs={group.runs} width={graphWidth} selectedId={selected?.id ?? null} now={now} onSelect={setPickedRun} /> : null}
            </div>
            {selected ? (
              <div className="min-w-0 shrink-0" style={split ? { width: INSPECTOR_WIDTH } : undefined}>
                <AgentInspector key={selected.id} run={selected} runs={group.runs} now={now} sessionId={sessionId} onSelect={setPickedRun} />
              </div>
            ) : null}
          </div>
        )}
      </div>
    </PanelFrame>
  );
}
