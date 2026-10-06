import { describe, expect, it } from 'vitest';
import { graphDepths, validateGraph } from '../../src/shared/agentGraph';
import { runGraph, type GraphControl, type GraphNode, type NodeState } from '../../src/main/agent/orchestrator';
import { routeModel } from '../../src/main/agent/modelRouter';
import { resolveRole, ROLES } from '../../src/main/agent/roles';
import { fakeModel } from '../support/fakeProvider';

const node = (id: string, dependsOn: string[] = [], extra: Partial<GraphNode> = {}): GraphNode => ({ id, dependsOn, exclusive: false, maxAttempts: 1, timeoutMs: 5_000, ...extra });
const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('an agent graph', () => {
  it('is rejected when it names an agent twice, depends on one that is missing, or loops', () => {
    expect(validateGraph([node('a'), node('b', ['a'])])).toBeNull();
    expect(validateGraph([node('a'), node('a')])).toMatch(/twice/);
    expect(validateGraph([node('a', ['ghost'])])).toMatch(/ghost/);
    expect(validateGraph([node('a', ['a'])])).toMatch(/itself/);
    expect(validateGraph([node('a', ['c']), node('b', ['a']), node('c', ['b'])])).toMatch(/loop/i);
  });

  it('lays agents out in steps: each one after everything it depends on', () => {
    const depths = graphDepths([node('plan'), node('explore-a', ['plan']), node('explore-b', ['plan']), node('build', ['explore-a', 'explore-b']), node('review', ['build']), node('notes', ['plan'])]);
    expect(depths).toEqual({ plan: 0, 'explore-a': 1, 'explore-b': 1, build: 2, review: 3, notes: 1 });
  });
});

describe('running an agent graph', () => {
  it('runs independent agents at the same time, and dependents after them with their results', async () => {
    const running = new Set<string>();
    let peak = 0;
    const received: Record<string, string[]> = {};
    const results = await runGraph<string>({
      nodes: [node('a'), node('b'), node('c', ['a', 'b'])],
      concurrency: 4,
      signal: new AbortController().signal,
      run: async (n, _attempt, _signal, deps) => {
        running.add(n.id);
        peak = Math.max(peak, running.size);
        received[n.id] = [...deps.keys()];
        await tick(15);
        running.delete(n.id);
        return `result of ${n.id}`;
      }
    });
    expect(peak).toBe(2);
    expect(received.c).toEqual(['a', 'b']);
    expect([...results.values()].map((r) => r.status)).toEqual(['done', 'done', 'done']);
    expect(results.get('c')?.value).toBe('result of c');
  });

  it('never runs more agents at once than allowed', async () => {
    let active = 0;
    let peak = 0;
    await runGraph<number>({
      nodes: ['a', 'b', 'c', 'd', 'e'].map((id) => node(id)),
      concurrency: 2,
      signal: new AbortController().signal,
      run: async () => {
        active++;
        peak = Math.max(peak, active);
        await tick(10);
        active--;
        return 1;
      }
    });
    expect(peak).toBe(2);
  });

  it('runs agents that change files one at a time, while readers go on beside them', async () => {
    const writers = new Set<string>();
    let writerPeak = 0;
    let readerBesideWriter = false;
    await runGraph<number>({
      nodes: [node('w1', [], { exclusive: true }), node('w2', [], { exclusive: true }), node('r1'), node('r2')],
      concurrency: 4,
      signal: new AbortController().signal,
      run: async (n) => {
        if (n.exclusive) {
          writers.add(n.id);
          writerPeak = Math.max(writerPeak, writers.size);
        } else if (writers.size > 0) readerBesideWriter = true;
        await tick(15);
        writers.delete(n.id);
        return 1;
      }
    });
    expect(writerPeak).toBe(1);
    expect(readerBesideWriter).toBe(true);
  });

  it('skips what depended on a failed agent and still finishes the rest', async () => {
    const results = await runGraph<string>({
      nodes: [node('a'), node('b', ['a']), node('c', ['b']), node('other')],
      concurrency: 4,
      signal: new AbortController().signal,
      run: (n) => (n.id === 'a' ? Promise.reject(new Error('boom')) : Promise.resolve('ok'))
    });
    expect(results.get('a')).toMatchObject({ status: 'failed', error: 'boom' });
    expect(results.get('b')).toMatchObject({ status: 'skipped' });
    expect(results.get('b')?.error).toMatch(/a/);
    expect(results.get('c')?.status).toBe('skipped');
    expect(results.get('other')?.status).toBe('done');
  });

  it('tries again after an error worth retrying, and gives up after the allowed attempts', async () => {
    const attempts: number[] = [];
    const states: NodeState[] = [];
    const results = await runGraph<string>({
      nodes: [node('flaky', [], { maxAttempts: 3 }), node('hopeless', [], { maxAttempts: 2 }), node('wrong', [], { maxAttempts: 3 })],
      concurrency: 1,
      signal: new AbortController().signal,
      backoffMs: () => 1,
      isRetryable: (error) => (error as Error).message !== 'bad input',
      onState: (id, state) => {
        if (id === 'flaky') states.push(state);
      },
      run: (n, attempt) => {
        if (n.id === 'flaky') {
          attempts.push(attempt);
          return attempt < 3 ? Promise.reject(new Error('overloaded')) : Promise.resolve('third time');
        }
        return Promise.reject(new Error(n.id === 'wrong' ? 'bad input' : 'overloaded'));
      }
    });
    expect(attempts).toEqual([1, 2, 3]);
    expect(results.get('flaky')).toMatchObject({ status: 'done', value: 'third time', attempts: 3 });
    expect(results.get('flaky')?.history.map((h) => h.error)).toEqual(['overloaded', 'overloaded']);
    expect(results.get('hopeless')).toMatchObject({ status: 'failed', attempts: 2 });
    expect(results.get('wrong')).toMatchObject({ status: 'failed', attempts: 1 });
    expect(states.map((s) => s.status)).toEqual(['running', 'retrying', 'running', 'retrying', 'running', 'done']);
  });

  it('stops an agent that runs past its time limit and does not try it again', async () => {
    let aborted = false;
    let calls = 0;
    const results = await runGraph<string>({
      nodes: [node('slow', [], { timeoutMs: 20, maxAttempts: 3 })],
      concurrency: 1,
      signal: new AbortController().signal,
      run: (_n, _attempt, signal) =>
        new Promise((_resolve, reject) => {
          calls++;
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        })
    });
    expect(aborted).toBe(true);
    expect(calls).toBe(1);
    expect(results.get('slow')?.status).toBe('failed');
    expect(results.get('slow')?.error).toMatch(/time limit/);
  });

  it('cancels everything when the turn is stopped: running agents are told, waiting ones never start', async () => {
    const controller = new AbortController();
    const started: string[] = [];
    const done = runGraph<string>({
      nodes: [node('a'), node('b', ['a']), node('c')],
      concurrency: 1,
      signal: controller.signal,
      run: (n, _attempt, signal) =>
        new Promise((_resolve, reject) => {
          started.push(n.id);
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    });
    await tick(10);
    controller.abort();
    const results = await done;
    expect(started).toEqual(['a']);
    expect([...results.values()].map((r) => r.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
  });
});

describe('agents that change different parts of the project', () => {
  /** Runs the graph and records, for each node, which others were running while it ran. */
  async function overlaps(nodes: GraphNode[], concurrency = 8): Promise<{ together: Record<string, string[]>; order: string[] }> {
    const running = new Set<string>();
    const together: Record<string, Set<string>> = {};
    const order: string[] = [];
    await runGraph<string>({
      nodes,
      concurrency,
      signal: new AbortController().signal,
      run: async (n) => {
        order.push(n.id);
        together[n.id] = new Set(running);
        for (const other of running) together[other]?.add(n.id);
        running.add(n.id);
        await tick(20);
        running.delete(n.id);
        return n.id;
      }
    });
    return { together: Object.fromEntries(Object.entries(together).map(([id, set]) => [id, [...set].sort()])), order };
  }

  it('work side by side when their paths cannot name the same file', async () => {
    const { together } = await overlaps([node('api', [], { paths: ['src/api/**'] }), node('ui', [], { paths: ['src/ui/**'] }), node('docs', [], { paths: ['docs/**', 'README.md'] })]);
    expect(together.api).toEqual(['docs', 'ui']);
    expect(together.ui).toEqual(['api', 'docs']);
  });

  it('take turns when their paths overlap', async () => {
    const { together, order } = await overlaps([node('all-src', [], { paths: ['src/**'] }), node('api', [], { paths: ['src/api/users.ts'] }), node('docs', [], { paths: ['docs/**'] })]);
    expect(together['all-src']).toEqual(['docs']);
    expect(together.api).not.toContain('all-src');
    expect(order.indexOf('all-src')).toBeLessThan(order.indexOf('api'));
  });

  it('never work beside an agent that has the whole project to itself', async () => {
    const { together } = await overlaps([node('anything', [], { exclusive: true }), node('api', [], { paths: ['src/api/**'] }), node('reader'), node('ui', [], { paths: ['src/ui/**'] })]);
    // The reader runs beside everyone; the two with paths run together, but neither beside the one that may change anything.
    expect(together.anything).toEqual(['reader']);
    expect(together.api).toContain('ui');
    expect(together.api).not.toContain('anything');
  });

  it('still count towards how many agents work at once', async () => {
    let active = 0;
    let peak = 0;
    await runGraph<string>({
      nodes: ['a', 'b', 'c', 'd'].map((id) => node(id, [], { paths: [`pkg/${id}/**`] })),
      concurrency: 2,
      signal: new AbortController().signal,
      run: async (n) => {
        active++;
        peak = Math.max(peak, active);
        await tick(10);
        active--;
        return n.id;
      }
    });
    expect(peak).toBe(2);
  });

  it('let one that waited for a path start as soon as the path is free, without waiting for unrelated work', async () => {
    const started: Record<string, number> = {};
    const ended: Record<string, number> = {};
    const t0 = Date.now();
    await runGraph<string>({
      nodes: [node('first', [], { paths: ['src/api/**'] }), node('second', [], { paths: ['src/api/users.ts'] }), node('slow-reader')],
      concurrency: 8,
      signal: new AbortController().signal,
      run: async (n) => {
        started[n.id] = Date.now() - t0;
        await tick(n.id === 'slow-reader' ? 120 : 20);
        ended[n.id] = Date.now() - t0;
        return n.id;
      }
    });
    expect(started.second!).toBeGreaterThanOrEqual(ended.first! - 2);
    expect(started.second!).toBeLessThan(ended['slow-reader']!);
  });
});

describe('stopping one agent of a graph', () => {
  /** Runs until its signal aborts, then fails the way a stopped model request does. */
  const untilStopped = (signal: AbortSignal): Promise<never> =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });

  it('stops the one that is running, skips what waited for it, and lets the rest finish', async () => {
    let control: GraphControl | null = null;
    const states: Array<[string, string]> = [];
    const pending = runGraph<string>({
      nodes: [node('slow'), node('other'), node('after-slow', ['slow']), node('after-other', ['other'])],
      concurrency: 4,
      signal: new AbortController().signal,
      onControl: (c) => (control = c),
      onState: (id, state) => states.push([id, state.status]),
      run: async (n, _attempt, signal) => {
        if (n.id === 'slow') return untilStopped(signal);
        await tick(20);
        return n.id;
      }
    });
    await tick();
    expect(control!.stop('slow')).toBe(true);
    const results = await pending;
    expect(Object.fromEntries([...results].map(([id, r]) => [id, r.status]))).toEqual({ slow: 'cancelled', other: 'done', 'after-slow': 'skipped', 'after-other': 'done' });
    expect(results.get('slow')?.error).toBe('Stopped by the user.');
    expect(results.get('after-slow')?.error).toMatch(/"slow", which did not run/);
    expect(states).toContainEqual(['slow', 'cancelled']);
  });

  it('stops one that has not started yet, without waiting for anything to finish', async () => {
    let control: GraphControl | null = null;
    const started: string[] = [];
    const states: Array<[string, string]> = [];
    const pending = runGraph<string>({
      nodes: [node('first'), node('second', ['first']), node('third', ['second'])],
      concurrency: 4,
      signal: new AbortController().signal,
      onControl: (c) => (control = c),
      onState: (id, state) => states.push([id, state.status]),
      run: async (n) => {
        started.push(n.id);
        await tick(30);
        return n.id;
      }
    });
    await tick();
    expect(control!.stop('second')).toBe(true);
    // Told at once: the graph does not wait for "first" to end before saying so.
    await tick();
    expect(states).toContainEqual(['second', 'cancelled']);
    expect(states).toContainEqual(['third', 'skipped']);
    const results = await pending;
    expect(started).toEqual(['first']);
    expect([...results.values()].map((r) => r.status)).toEqual(['done', 'cancelled', 'skipped']);
  });

  it('does not try a stopped agent again, even while it waits to retry', async () => {
    let control: GraphControl | null = null;
    let attempts = 0;
    const pending = runGraph<string>({
      nodes: [node('flaky', [], { maxAttempts: 5 })],
      concurrency: 1,
      signal: new AbortController().signal,
      onControl: (c) => (control = c),
      backoffMs: () => 10_000,
      run: () => {
        attempts++;
        return Promise.reject(new Error('rate limited'));
      }
    });
    await tick();
    expect(control!.stop('flaky')).toBe(true);
    const results = await pending;
    expect(attempts).toBe(1);
    expect(results.get('flaky')?.status).toBe('cancelled');
  });

  it('has nothing to stop once an agent finished, or when there is no such agent', async () => {
    let control: GraphControl | null = null;
    await runGraph<string>({
      nodes: [node('a')],
      concurrency: 1,
      signal: new AbortController().signal,
      onControl: (c) => (control = c),
      run: () => Promise.resolve('done')
    });
    expect(control!.stop('a')).toBe(false);
    expect(control!.stop('ghost')).toBe(false);
  });
});

describe('agent roles', () => {
  it('covers the roles a piece of software work needs', () => {
    expect(Object.keys(ROLES).sort()).toEqual(
      ['architect', 'browser', 'debugger', 'docs', 'explorer', 'implementer', 'performance', 'planner', 'researcher', 'reviewer', 'security', 'tester', 'ui-reviewer'].sort()
    );
  });

  const available = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Edit', 'Write', 'MultiEdit', 'Shell', 'ShellOutput', 'KillShell', 'Browser', 'Task', 'RunAgents', 'TodoWrite', 'AskUserQuestion', 'ExitPlanMode', 'mcp__github__search'];

  it('gives readers only tools that look, and lets one agent at a time change files', () => {
    const explorer = resolveRole('explorer', available, []);
    expect(explorer.ok && explorer.tools).toEqual(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']);
    expect(explorer.ok && explorer.exclusive).toBe(false);
    const implementer = resolveRole('implementer', available, []);
    expect(implementer.ok && implementer.exclusive).toBe(true);
    expect(implementer.ok && implementer.tools).toContain('Edit');
  });

  it('never hands an agent the tools that belong to the main agent, whatever its role', () => {
    for (const role of Object.keys(ROLES)) {
      const resolved = resolveRole(role, available, []);
      expect(resolved.ok && resolved.tools.some((t) => ['Task', 'RunAgents', 'TodoWrite', 'AskUserQuestion', 'ExitPlanMode'].includes(t))).toBe(false);
    }
  });

  it('lets the browser roles drive the browser, one at a time', () => {
    const browser = resolveRole('browser', available, []);
    expect(browser.ok && browser.tools).toContain('Browser');
    expect(browser.ok && browser.exclusive).toBe(true);
    expect(resolveRole('reviewer', available, []).ok && (resolveRole('reviewer', available, []) as { tools: string[] }).tools).not.toContain('Browser');
  });

  it('accepts a custom agent as a role, limited to the tools it lists and the session has', () => {
    const custom = [{ name: 'matcher', description: 'Matches a function', tools: ['Read', 'Edit', 'Shell', 'Nope'], instructions: 'Match it.', source: 'project' as const, path: 'x' }];
    const resolved = resolveRole('matcher', available, custom);
    expect(resolved.ok && resolved.tools).toEqual(['Read', 'Edit', 'Shell']);
    expect(resolved.ok && resolved.exclusive).toBe(true);
    expect(resolved.ok && resolved.brief).toContain('Match it.');
  });

  it('explains which roles exist when asked for one that does not', () => {
    const resolved = resolveRole('wizard', available, []);
    expect(resolved.ok).toBe(false);
    expect(!resolved.ok && resolved.error).toMatch(/explorer/);
  });
});

describe('choosing a model for an agent', () => {
  const session = fakeModel({ ref: { providerId: 'or', modelId: 'big' }, label: 'Big', pricing: { input: 3, output: 15 } });
  const cheap = fakeModel({ ref: { providerId: 'or', modelId: 'small' }, label: 'Small', cheap: true, pricing: { input: 0.2, output: 0.8 } });
  const noTools = fakeModel({ ref: { providerId: 'or', modelId: 'tiny' }, label: 'Tiny', supportsTools: false, pricing: { input: 0.05, output: 0.1 } });
  const blind = fakeModel({ ref: { providerId: 'or', modelId: 'blind' }, label: 'Blind', supportsVision: false, pricing: { input: 0.1, output: 0.4 } });
  const elsewhere = fakeModel({ ref: { providerId: 'other', modelId: 'bargain' }, label: 'Bargain', pricing: { input: 0.01, output: 0.02 } });
  const candidates = [session, cheap, noTools, blind, elsewhere];

  it('uses the model assigned to the role in Settings, and says so', () => {
    const routed = routeModel({ modelRole: 'reviewer', needsVision: false, session, candidates, routing: 'session', assignments: { reviewer: cheap.ref } });
    expect(routed.ref).toEqual(cheap.ref);
    expect(routed.reasons.join(' ')).toMatch(/assigned/i);
  });

  it('falls back to the session model when the assigned one is gone, and says why', () => {
    const routed = routeModel({ modelRole: 'reviewer', needsVision: false, session, candidates, routing: 'session', assignments: { reviewer: { providerId: 'or', modelId: 'retired' } } });
    expect(routed.ref).toEqual(session.ref);
    expect(routed.reasons.join(' ')).toMatch(/retired/);
  });

  it('keeps the session model unless routing is automatic', () => {
    const routed = routeModel({ modelRole: 'fast', needsVision: false, session, candidates, routing: 'session', assignments: {} });
    expect(routed.ref).toEqual(session.ref);
  });

  it('picks the cheapest capable model from the same provider for quick and research work', () => {
    const routed = routeModel({ modelRole: 'research', needsVision: false, session, candidates, routing: 'auto', assignments: {} });
    expect(routed.ref).toEqual(blind.ref);
    expect(routed.reasons.join(' ')).toMatch(/cheapest/i);
    expect(routed.reasons.join(' ')).toContain('$0.1');
  });

  it('only picks models that can see for roles that look at screens', () => {
    const routed = routeModel({ modelRole: 'fast', needsVision: true, session, candidates, routing: 'auto', assignments: {} });
    expect(routed.ref).toEqual(cheap.ref);
  });

  it('keeps the session model for work that needs its strongest reasoning', () => {
    const routed = routeModel({ modelRole: 'coder', needsVision: false, session, candidates, routing: 'auto', assignments: {} });
    expect(routed.ref).toEqual(session.ref);
    expect(routed.reasons.join(' ')).toMatch(/session/i);
  });

  it('never routes to a model that cannot use tools, or to another provider on its own', () => {
    const routed = routeModel({ modelRole: 'fast', needsVision: false, session, candidates: [session, noTools, elsewhere], routing: 'auto', assignments: {} });
    expect(routed.ref).toEqual(session.ref);
  });
});
