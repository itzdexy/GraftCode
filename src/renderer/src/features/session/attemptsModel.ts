import type { Attempt, AttemptSet } from '@shared/schemas/attempts';
import { formatDuration } from '../../lib/format';
import { money } from '../panels/agentGraphLayout';

/**
 * What the card of a message sent as attempts shows for each attempt (pure, so
 * it is unit-tested without a DOM): its state in words, what it changed, how
 * its checks went, what it used, and what can be done with it now.
 */

export type AttemptState = 'Waiting' | 'Running' | 'Checking' | 'Done' | 'Failed' | 'Stopped' | 'Applied';

export interface AttemptRow {
  index: number;
  model: string;
  state: AttemptState;
  tone: 'neutral' | 'accent' | 'danger' | 'warning';
  /** What it is doing, while it runs. */
  activity: string | null;
  error: string | null;
  notes: string[];
  files: { count: number; added: number; removed: number };
  /** Null when no checks ran (a note says why, when there is a why). */
  checks: { label: string; failed: boolean } | null;
  /** Tokens sent and written. */
  tokens: number;
  /** "$0.004", "No published price", or null before it used anything. */
  cost: string | null;
  /** How long it has worked, or worked; null before it started. */
  time: string | null;
  report: string;
  canDiff: boolean;
  canApply: boolean;
  canStop: boolean;
}

const ACTIVE = new Set<Attempt['status']>(['queued', 'running', 'checking']);

function stateOf(set: AttemptSet, attempt: Attempt): { state: AttemptState; tone: AttemptRow['tone'] } {
  switch (attempt.status) {
    case 'queued':
      return { state: 'Waiting', tone: 'neutral' };
    case 'running':
      return { state: 'Running', tone: 'accent' };
    case 'checking':
      return { state: 'Checking', tone: 'accent' };
    case 'candidate':
      return set.applied === attempt.index ? { state: 'Applied', tone: 'accent' } : { state: 'Done', tone: 'neutral' };
    case 'failed':
      return { state: 'Failed', tone: 'danger' };
    case 'stopped':
      return { state: 'Stopped', tone: 'warning' };
  }
}

function checksOf(attempt: Attempt): AttemptRow['checks'] {
  const report = attempt.checks;
  if (!report) return null;
  if (report.passed) return { label: report.runs.length === 1 ? 'Check passed' : 'Checks passed', failed: false };
  const failed = report.runs.filter((r) => !r.passed).length;
  return { label: report.runs.length === 1 ? 'Check failed' : `${String(failed)} of ${String(report.runs.length)} checks failed`, failed: true };
}

/** Notes every attempt has (no checks are set up): said once on the card, not on each row. */
export function sharedNotes(set: AttemptSet): string[] {
  const [first, ...rest] = set.attempts;
  return rest.length === 0 ? [] : (first?.notes ?? []).filter((note) => rest.every((a) => a.notes.includes(note)));
}

export function attemptRows(set: AttemptSet, now: number): AttemptRow[] {
  const shared = sharedNotes(set);
  return set.attempts.map((attempt) => {
    const tokens = attempt.usage.inputTokens + attempt.usage.outputTokens;
    const changed = attempt.files.length > 0;
    const finished = attempt.status === 'candidate';
    return {
      index: attempt.index,
      model: attempt.model.label,
      ...stateOf(set, attempt),
      activity: attempt.status === 'running' ? attempt.activity : null,
      error: attempt.error,
      notes: attempt.notes.filter((note) => !shared.includes(note)),
      files: { count: attempt.files.length, added: attempt.files.reduce((n, f) => n + f.added, 0), removed: attempt.files.reduce((n, f) => n + f.removed, 0) },
      checks: checksOf(attempt),
      tokens,
      cost: attempt.costUsd !== null ? money(attempt.costUsd) : tokens > 0 ? 'No published price' : null,
      time: attempt.startedAt === null ? null : formatDuration(Math.max(0, (attempt.endedAt ?? now) - attempt.startedAt)),
      report: attempt.report,
      // Once one is applied, only its patch is kept: the others' checkouts went with it.
      canDiff: finished && changed && (set.status === 'open' || set.applied === attempt.index),
      canApply: finished && changed && set.status === 'open',
      canStop: set.status === 'running' && ACTIVE.has(attempt.status)
    };
  });
}

/** The card's heading: how many, and where they are. */
export function attemptsHeadline(set: AttemptSet): string {
  const total = set.attempts.length;
  if (set.status === 'applied') return `Applied attempt ${String(set.applied ?? 0)} of ${String(total)}`;
  if (set.status === 'discarded') return `${String(total)} attempts, discarded`;
  const count = (test: (a: Attempt) => boolean): number => set.attempts.filter(test).length;
  const ready = count((a) => a.status === 'candidate');
  if (set.status === 'running') {
    const working = count((a) => ACTIVE.has(a.status));
    return `${String(total)} attempts · ${String(working)} working${ready > 0 ? `, ${String(ready)} done` : ''}`;
  }
  if (ready === 0) return `${String(total)} attempts · none finished`;
  return `${String(total)} attempts · ${String(ready)} ready to compare`;
}
