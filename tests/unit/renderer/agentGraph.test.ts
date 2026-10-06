import { describe, expect, it } from 'vitest';
import {
  clock,
  groupElapsed,
  groupsOf,
  groupTotals,
  layoutAgentGraph,
  MAX_NODE_WIDTH,
  MIN_NODE_WIDTH,
  money,
  NODE_HEIGHT,
  pickAgent,
  runDuration,
  runsNote,
  type AgentBox
} from '../../../src/renderer/src/features/panels/agentGraphLayout';
import type { AgentRun } from '../../../src/shared/schemas/agentRuns';
import { makeAgentRun } from './agentRun';

const run = makeAgentRun;

const centre = (box: AgentBox): number => Math.round(box.x + box.width / 2);

describe('the agent graph', () => {
  it('puts each agent one step below the latest thing it waits for, and agents of the same step side by side', () => {
    const layout = layoutAgentGraph([run('plan'), run('a', ['plan']), run('b', ['plan']), run('build', ['a', 'b'])], 400);
    const at = Object.fromEntries(layout.nodes.map((n) => [n.run.nodeId, n]));
    expect(at.plan!.y).toBeLessThan(at.a!.y);
    expect(at.a!.y).toBe(at.b!.y);
    expect(at.b!.x).toBeGreaterThanOrEqual(at.a!.x + at.a!.width);
    expect(at.build!.y).toBeGreaterThan(at.a!.y);
    // A step with one agent sits in the middle, under or over the ones it connects to.
    expect(centre(at.plan!)).toBe(200);
    expect(centre(at.build!)).toBe(200);
    // Nothing leaves the drawing, and no agent is wider than it needs to be.
    for (const n of layout.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x + n.width).toBeLessThanOrEqual(400);
      expect(n.y + NODE_HEIGHT).toBeLessThanOrEqual(layout.height);
      expect(n.width).toBeLessThanOrEqual(MAX_NODE_WIDTH);
    }
    expect(layout.width).toBe(400);
  });

  it('wraps a step onto more lines rather than squeezing its agents until they cannot be read', () => {
    const layout = layoutAgentGraph([run('a'), run('b'), run('c'), run('d'), run('e'), run('last', ['a', 'b', 'c', 'd', 'e'])], 300);
    const firstStep = layout.nodes.filter((n) => n.run.nodeId !== 'last');
    // 300px holds two readable agents side by side: five agents take three lines.
    expect(new Set(firstStep.map((n) => n.y)).size).toBe(3);
    for (const n of firstStep) expect(n.width).toBeGreaterThanOrEqual(MIN_NODE_WIDTH);
    const last = layout.nodes.find((n) => n.run.nodeId === 'last')!;
    expect(last.y).toBeGreaterThan(Math.max(...firstStep.map((n) => n.y)) + NODE_HEIGHT);
  });

  it('still draws every agent in a panel narrower than one agent', () => {
    const layout = layoutAgentGraph([run('a'), run('b')], 80);
    expect(layout.nodes.map((n) => [n.x, n.width])).toEqual([
      [0, 80],
      [0, 80]
    ]);
    expect(layout.nodes[1]!.y).toBeGreaterThan(layout.nodes[0]!.y);
  });

  it('draws one line for every dependency, from the bottom of one agent to the top of the next', () => {
    const layout = layoutAgentGraph([run('a'), run('b'), run('c', ['a', 'b'])], 400);
    expect(layout.edges.map((e) => [e.from, e.to])).toEqual([
      ['a', 'c'],
      ['b', 'c']
    ]);
    const a = layout.nodes.find((n) => n.run.nodeId === 'a')!;
    const c = layout.nodes.find((n) => n.run.nodeId === 'c')!;
    expect(layout.edges[0]!.path.startsWith(`M ${String(centre(a))} ${String(a.y + NODE_HEIGHT)} `)).toBe(true);
    expect(layout.edges[0]!.path.endsWith(` ${String(centre(c))} ${String(c.y)}`)).toBe(true);
  });

  it('leaves out a line to an agent that is not in the group', () => {
    expect(layoutAgentGraph([run('a', ['gone'])], 400).edges).toEqual([]);
  });

  it('marks a line as open until the agent it comes from is done', () => {
    const open = layoutAgentGraph([run('a', [], { status: 'running' }), run('b', ['a'], { status: 'queued' })], 400);
    expect(open.edges[0]!.settled).toBe(false);
    expect(layoutAgentGraph([run('a'), run('b', ['a'])], 400).edges[0]!.settled).toBe(true);
    // Nothing came out of an agent that failed.
    expect(layoutAgentGraph([run('a', [], { status: 'failed' }), run('b', ['a'], { status: 'skipped' })], 400).edges[0]!.settled).toBe(false);
  });

  it('draws nothing for no agents', () => {
    expect(layoutAgentGraph([], 400)).toEqual({ nodes: [], edges: [], width: 400, height: 0 });
  });

  it('keeps the groups of a session apart, oldest first, each with a count of what is still going', () => {
    const groups = groupsOf([
      run('x', [], { groupId: 'g2', goal: 'Second', createdAt: 5 }),
      run('a'),
      run('b', [], { status: 'running' })
    ]);
    expect(groups.map((g) => [g.id, g.goal, g.runs.map((r) => r.nodeId), g.active])).toEqual([
      ['g1', 'Ship it', ['a', 'b'], 1],
      ['g2', 'Second', ['x'], 0]
    ]);
  });

  it('adds up a group: how each agent ended, the tokens, and the cost only when every agent that ran has one', () => {
    const spent = (inputTokens: number, outputTokens: number): AgentRun['usage'] => ({ inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
    const priced = [run('a', [], { usage: spent(100, 20), costUsd: 0.01 }), run('b', [], { usage: spent(10, 5), costUsd: 0.02 })];
    expect(groupTotals(priced)).toEqual({ total: 2, done: 2, failed: 0, active: 0, tokens: 135, costUsd: 0.03 });
    const mixed = [...priced, run('c', [], { status: 'failed', usage: spent(7, 0), costUsd: null }), run('d', [], { status: 'queued', startedAt: null, endedAt: null })];
    expect(groupTotals(mixed)).toEqual({ total: 4, done: 2, failed: 1, active: 1, tokens: 142, costUsd: null });
    // An agent that never ran spent nothing, so it does not hide the cost of the others.
    const skipped = [...priced, run('e', [], { status: 'skipped', startedAt: null, endedAt: null })];
    expect(groupTotals(skipped).costUsd).toBe(0.03);
  });

  it('times a group from its first start to its last end, or to now while any agent works', () => {
    const ended = [run('a', [], { startedAt: 1000, endedAt: 3000 }), run('b', [], { startedAt: 2000, endedAt: 7000 }), run('c', [], { status: 'skipped', startedAt: null, endedAt: 7000 })];
    expect(groupElapsed(ended, 99_000)).toBe(6000);
    expect(groupElapsed([...ended, run('d', [], { status: 'running', startedAt: 8000, endedAt: null })], 20_000)).toBe(19_000);
    expect(groupElapsed([run('q', [], { status: 'queued', startedAt: null, endedAt: null })], 5000)).toBeNull();
  });

  it('opens on the agent that needs looking at: one working, else one that failed, else the last to finish', () => {
    const done = run('a', [], { endedAt: 10 });
    const later = run('b', [], { endedAt: 30 });
    expect(pickAgent([done, later])?.nodeId).toBe('b');
    expect(pickAgent([done, run('f', [], { status: 'failed' }), later])?.nodeId).toBe('f');
    expect(pickAgent([done, run('f', [], { status: 'failed' }), run('r', [], { status: 'retrying' }), run('w', [], { status: 'running' })])?.nodeId).toBe('r');
    expect(pickAgent([run('q', [], { status: 'queued', startedAt: null, endedAt: null })])?.nodeId).toBe('q');
    expect(pickAgent([])).toBeNull();
  });

  it('writes a running time as a clock that does not jump about', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(9_400)).toBe('0:09');
    expect(clock(65_000)).toBe('1:05');
    expect(clock(3_725_000)).toBe('1:02:05');
  });

  it('writes what an agent cost with enough decimals to show the small amounts agents cost', () => {
    expect(money(0.0042)).toBe('$0.004');
    expect(money(0.25)).toBe('$0.25');
    expect(money(12)).toBe('$12.00');
  });

  it('times an agent from its start to its end, or to now while it runs', () => {
    expect(runDuration(run('a', [], { startedAt: 1000, endedAt: 4000 }), 9000)).toBe(3000);
    expect(runDuration(run('a', [], { status: 'running', startedAt: 1000, endedAt: null }), 9000)).toBe(8000);
    expect(runDuration(run('a', [], { status: 'queued', startedAt: null, endedAt: null }), 9000)).toBeNull();
  });

  it('says how an agent shares the project: alone, beside the others as a reader, or beside them with paths of its own', () => {
    expect(runsNote(run('a', [], { exclusive: true }))).toMatch(/One at a time/);
    expect(runsNote(run('a', [], { exclusive: false }))).toMatch(/only reads/);
    expect(runsNote(run('a', [], { exclusive: false, writes: ['src/api/**'] }))).toMatch(/own paths/);
  });
});
