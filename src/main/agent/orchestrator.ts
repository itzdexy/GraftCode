import type { GraphShape } from '@shared/agentGraph';
import { anyOverlap } from '@shared/writeScopes';

/**
 * Runs a graph of agents: each one starts once everything it depends on has
 * finished, and independent ones run side by side up to a limit. An agent
 * that may change any file, or that drives the browser, has the project to
 * itself; agents given paths of their own work side by side as long as their
 * paths can't name the same file. A failure stops only what depended on it.
 * Knows nothing about models or tools: `run` does the work, so the scheduling
 * is tested on its own.
 */
export interface GraphNode extends GraphShape {
  /** May change any file, or uses something there is one of (the browser): never beside another exclusive node or one with paths. */
  exclusive: boolean;
  /** The paths it alone may change while it runs. It never runs beside a node whose paths overlap its own, nor beside an exclusive one. */
  paths?: string[];
  /** How many times it may run before it counts as failed. */
  maxAttempts: number;
  timeoutMs: number;
}

export type NodeStatus = 'queued' | 'running' | 'retrying' | 'done' | 'failed' | 'skipped' | 'cancelled';

export interface NodeState {
  status: NodeStatus;
  attempt: number;
  error: string | null;
}

export interface NodeResult<T> {
  status: 'done' | 'failed' | 'skipped' | 'cancelled';
  value: T | null;
  error: string | null;
  /** Attempts that ran (0 for a node that never started). */
  attempts: number;
  /** The attempts that failed before the last one. */
  history: Array<{ attempt: number; error: string }>;
}

/** Handed to the caller while the graph runs, to stop one node of it. */
export interface GraphControl {
  /** Stops a node that is waiting or running; what depended on it is skipped. False when it already ended or isn't in the graph. */
  stop(id: string): boolean;
}

export interface RunGraphOptions<T> {
  nodes: GraphNode[];
  /** Most nodes running at once. */
  concurrency: number;
  /** Aborting it cancels the running nodes and everything still waiting. */
  signal: AbortSignal;
  /** Does one node's work. `deps` holds the results of what it depends on; `signal` aborts on stop and at the node's time limit. */
  run(node: GraphNode, attempt: number, signal: AbortSignal, deps: Map<string, T>): Promise<T>;
  onState?(id: string, state: NodeState): void;
  onControl?(control: GraphControl): void;
  /** Whether a failure is worth another attempt (default: yes). */
  isRetryable?(error: unknown): boolean;
  /** Pause before attempt n+1 (default: two seconds per attempt so far). */
  backoffMs?(attempt: number): number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function minutes(ms: number): string {
  const m = ms / 60_000;
  return m >= 1 ? `${String(Math.round(m))} minute${Math.round(m) === 1 ? '' : 's'}` : `${String(Math.round(ms / 1000))} seconds`;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/** Runs the graph to the end and returns each node's outcome, in the order the nodes were given. Never rejects. */
export async function runGraph<T>(options: RunGraphOptions<T>): Promise<Map<string, NodeResult<T>>> {
  const outcomes = new Map<string, NodeResult<T>>();
  const waiting = new Map(options.nodes.map((n) => [n.id, n]));
  const running = new Map<string, Promise<void>>();
  /** One per running node: aborted when the whole graph stops or when that node alone is stopped. */
  const halts = new Map<string, AbortController>();
  let exclusiveBusy = false;
  /** The paths held by the nodes running now. */
  const claimed = new Map<string, string[]>();
  /** Ends the wait for a running node early, so a change made from outside is acted on now. */
  let wake = (): void => undefined;
  const tell = (id: string, state: NodeState): void => options.onState?.(id, state);

  const attemptLoop = async (node: GraphNode, halt: AbortSignal): Promise<NodeResult<T>> => {
    const history: Array<{ attempt: number; error: string }> = [];
    for (let attempt = 1; ; attempt++) {
      tell(node.id, { status: 'running', attempt, error: null });
      const controller = new AbortController();
      const stop = (): void => controller.abort();
      halt.addEventListener('abort', stop, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, node.timeoutMs);
      try {
        const deps = new Map<string, T>();
        for (const dep of node.dependsOn) {
          const value = outcomes.get(dep)?.value;
          if (value !== null && value !== undefined) deps.set(dep, value);
        }
        const value = await options.run(node, attempt, controller.signal, deps);
        tell(node.id, { status: 'done', attempt, error: null });
        return { status: 'done', value, error: null, attempts: attempt, history };
      } catch (error) {
        if (halt.aborted) {
          tell(node.id, { status: 'cancelled', attempt, error: null });
          return { status: 'cancelled', value: null, error: 'Stopped by the user.', attempts: attempt, history };
        }
        // A time limit that was hit once will be hit again; a retry would only spend more.
        const message = timedOut ? `Stopped at its time limit of ${minutes(node.timeoutMs)}.` : messageOf(error);
        if (!timedOut && attempt < node.maxAttempts && (options.isRetryable?.(error) ?? true)) {
          history.push({ attempt, error: message });
          tell(node.id, { status: 'retrying', attempt, error: message });
          await pause(options.backoffMs?.(attempt) ?? 2_000 * attempt, halt);
          if (halt.aborted) {
            tell(node.id, { status: 'cancelled', attempt, error: null });
            return { status: 'cancelled', value: null, error: 'Stopped by the user.', attempts: attempt, history };
          }
          continue;
        }
        tell(node.id, { status: 'failed', attempt, error: message });
        return { status: 'failed', value: null, error: message, attempts: attempt, history };
      } finally {
        clearTimeout(timer);
        halt.removeEventListener('abort', stop);
      }
    }
  };

  const settleUnstarted = (node: GraphNode, status: 'skipped' | 'cancelled', error: string): void => {
    waiting.delete(node.id);
    outcomes.set(node.id, { status, value: null, error, attempts: 0, history: [] });
    tell(node.id, { status, attempt: 0, error });
  };

  options.onControl?.({
    stop: (id) => {
      const halt = halts.get(id);
      if (halt) {
        if (halt.signal.aborted) return false;
        halt.abort();
        return true;
      }
      const node = waiting.get(id);
      if (!node) return false;
      settleUnstarted(node, 'cancelled', 'Stopped by the user.');
      wake();
      return true;
    }
  });

  for (;;) {
    if (options.signal.aborted) {
      for (const node of [...waiting.values()]) settleUnstarted(node, 'cancelled', 'Stopped by the user.');
    }
    // Whatever waited on something that didn't finish can't run; that in turn may strand others.
    for (let changed = true; changed; ) {
      changed = false;
      for (const node of [...waiting.values()]) {
        const broken = node.dependsOn.find((dep) => {
          const outcome = outcomes.get(dep);
          return outcome !== undefined && outcome.status !== 'done';
        });
        if (broken === undefined) continue;
        const how = outcomes.get(broken)?.status === 'failed' ? 'failed' : 'did not run';
        settleUnstarted(node, 'skipped', `Skipped: it depends on "${broken}", which ${how}.`);
        changed = true;
      }
    }
    for (const node of [...waiting.values()]) {
      if (running.size >= Math.max(1, options.concurrency)) break;
      if (!node.dependsOn.every((dep) => outcomes.get(dep)?.status === 'done')) continue;
      const paths = node.exclusive ? [] : (node.paths ?? []);
      if (node.exclusive && (exclusiveBusy || claimed.size > 0)) continue;
      if (paths.length > 0 && (exclusiveBusy || [...claimed.values()].some((held) => anyOverlap(held, paths)))) continue;
      waiting.delete(node.id);
      if (node.exclusive) exclusiveBusy = true;
      if (paths.length > 0) claimed.set(node.id, paths);
      const halt = new AbortController();
      const stopAll = (): void => halt.abort();
      options.signal.addEventListener('abort', stopAll, { once: true });
      halts.set(node.id, halt);
      running.set(
        node.id,
        attemptLoop(node, halt.signal).then((outcome) => {
          options.signal.removeEventListener('abort', stopAll);
          halts.delete(node.id);
          outcomes.set(node.id, outcome);
          running.delete(node.id);
          claimed.delete(node.id);
          if (node.exclusive) exclusiveBusy = false;
        })
      );
    }
    if (running.size === 0) {
      // Nothing runs and nothing can start: only a graph that was never validated gets here.
      for (const node of [...waiting.values()]) settleUnstarted(node, 'skipped', 'Skipped: what it depends on never finished.');
      break;
    }
    const woken = new Promise<void>((resolve) => {
      wake = resolve;
    });
    await Promise.race([...running.values(), woken]);
  }

  const ordered = new Map<string, NodeResult<T>>();
  for (const node of options.nodes) {
    const outcome = outcomes.get(node.id);
    if (outcome) ordered.set(node.id, outcome);
  }
  return ordered;
}
