import { graphDepths } from '@shared/agentGraph';
import { agentRunActive, type AgentRun } from '@shared/schemas/agentRuns';

/**
 * Where the agents of one group go in the Agents panel: steps run top to
 * bottom (a tall side panel has more height than width), agents of the same
 * step sit side by side, and a line joins each agent to what it waits for.
 */

/** Room for a title of two lines over a line that says how far along the agent is. */
export const NODE_HEIGHT = 64;
/** Narrower than this and a title can't be read even on two lines, so the step wraps onto another line. */
export const MIN_NODE_WIDTH = 104;
export const MAX_NODE_WIDTH = 220;
const GAP_X = 8;
/** Between two lines of the same step. */
const GAP_LINE = 8;
/** Between steps: room for the connecting lines. */
const GAP_STEP = 28;

export interface AgentBox {
  run: AgentRun;
  x: number;
  y: number;
  width: number;
}

export interface AgentEdge {
  from: string;
  to: string;
  /** SVG path from the bottom of one agent to the top of the next. */
  path: string;
  /** The agent it comes from is done, so its result has gone down this line. */
  settled: boolean;
}

export interface AgentGraphLayout {
  nodes: AgentBox[];
  edges: AgentEdge[];
  width: number;
  height: number;
}

export function layoutAgentGraph(runs: AgentRun[], width: number): AgentGraphLayout {
  const depths = graphDepths(runs.map((r) => ({ id: r.nodeId, dependsOn: r.dependsOn })));
  const steps: AgentRun[][] = [];
  for (const run of runs) (steps[depths[run.nodeId] ?? 0] ??= []).push(run);

  const perLine = Math.max(1, Math.floor((width + GAP_X) / (MIN_NODE_WIDTH + GAP_X)));
  const nodes: AgentBox[] = [];
  let y = 0;
  let height = 0;
  for (const step of steps) {
    if (!step) continue;
    for (let start = 0; start < step.length; start += perLine) {
      const line = step.slice(start, start + perLine);
      const boxWidth = Math.min(MAX_NODE_WIDTH, Math.floor((width - (line.length - 1) * GAP_X) / line.length));
      const left = Math.round((width - (line.length * boxWidth + (line.length - 1) * GAP_X)) / 2);
      line.forEach((run, i) => nodes.push({ run, x: left + i * (boxWidth + GAP_X), y, width: boxWidth }));
      height = y + NODE_HEIGHT;
      y += NODE_HEIGHT + GAP_LINE;
    }
    y += GAP_STEP - GAP_LINE;
  }

  const boxes = new Map(nodes.map((n) => [n.run.nodeId, n]));
  const edges: AgentEdge[] = [];
  for (const to of nodes) {
    for (const dep of to.run.dependsOn) {
      const from = boxes.get(dep);
      if (!from) continue;
      const x1 = Math.round(from.x + from.width / 2);
      const y1 = from.y + NODE_HEIGHT;
      const x2 = Math.round(to.x + to.width / 2);
      const bend = Math.round((y1 + to.y) / 2);
      edges.push({ from: dep, to: to.run.nodeId, path: `M ${x1} ${y1} C ${x1} ${bend} ${x2} ${bend} ${x2} ${to.y}`, settled: from.run.status === 'done' });
    }
  }
  return { nodes, edges, width, height };
}

export interface AgentGroup {
  id: string;
  goal: string;
  runs: AgentRun[];
  /** Agents still queued or working. */
  active: number;
  createdAt: number;
}

/** A session's agent runs as the groups they ran in, oldest group first. */
export function groupsOf(runs: AgentRun[]): AgentGroup[] {
  const groups = new Map<string, AgentGroup>();
  for (const run of runs) {
    let group = groups.get(run.groupId);
    if (!group) {
      group = { id: run.groupId, goal: run.goal, runs: [], active: 0, createdAt: run.createdAt };
      groups.set(run.groupId, group);
    }
    group.runs.push(run);
    group.createdAt = Math.min(group.createdAt, run.createdAt);
    if (agentRunActive(run.status)) group.active += 1;
  }
  return [...groups.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export interface GroupTotals {
  total: number;
  done: number;
  failed: number;
  active: number;
  /** Tokens sent and received by every agent. */
  tokens: number;
  /** Null when an agent that ran used a model without published prices. */
  costUsd: number | null;
}

export function groupTotals(runs: AgentRun[]): GroupTotals {
  const ran = runs.filter((r) => r.startedAt !== null);
  return {
    total: runs.length,
    done: runs.filter((r) => r.status === 'done').length,
    failed: runs.filter((r) => r.status === 'failed').length,
    active: runs.filter((r) => agentRunActive(r.status)).length,
    tokens: runs.reduce((sum, r) => sum + r.usage.inputTokens + r.usage.outputTokens, 0),
    costUsd: ran.every((r) => r.costUsd !== null) ? Math.round(ran.reduce((sum, r) => sum + (r.costUsd ?? 0), 0) * 1e6) / 1e6 : null
  };
}

/** How long an agent has run, or null before it starts. */
export function runDuration(run: AgentRun, now: number): number | null {
  if (run.startedAt === null) return null;
  return Math.max(0, (run.endedAt ?? now) - run.startedAt);
}

/** How long a group has been going: from its first start to its last end, or to now while any agent works. Null before anything started. */
export function groupElapsed(runs: AgentRun[], now: number): number | null {
  const starts = runs.flatMap((r) => (r.startedAt === null ? [] : [r.startedAt]));
  if (starts.length === 0) return null;
  const end = runs.some((r) => agentRunActive(r.status)) ? now : Math.max(...runs.map((r) => r.endedAt ?? 0));
  return Math.max(0, end - Math.min(...starts));
}

/** The agent the panel opens on: one that is working, else one that failed, else the last to finish, else the first. */
export function pickAgent(runs: AgentRun[]): AgentRun | null {
  const working = runs.find((r) => r.status === 'running' || r.status === 'retrying');
  if (working) return working;
  const failed = runs.find((r) => r.status === 'failed');
  if (failed) return failed;
  const done = runs.filter((r) => r.status === 'done');
  if (done.length > 0) return done.reduce((last, r) => ((r.endedAt ?? 0) >= (last.endedAt ?? 0) ? r : last));
  return runs[0] ?? null;
}

/** A running time as m:ss (h:mm:ss past an hour): whole seconds, so it doesn't flicker as it counts. */
export function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const two = (n: number): string => String(n).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours > 0 ? `${String(hours)}:${two(minutes)}:${two(total % 60)}` : `${String(minutes)}:${two(total % 60)}`;
}

/** How an agent shares the project with the others, in a sentence. */
export function runsNote(run: Pick<AgentRun, 'exclusive' | 'writes'>): string {
  if (run.writes.length > 0) return 'Beside other agents, each kept to its own paths';
  return run.exclusive ? 'One at a time: it may change any file or drive the browser' : 'Beside other agents: it only reads';
}

/** Money spent on a model. Under ten cents it keeps a third decimal: most agents cost fractions of a cent. */
export function money(usd: number): string {
  return `$${usd.toFixed(usd < 0.1 ? 3 : 2)}`;
}
