import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { EffortLevel, PermissionMode } from '@shared/schemas/common';
import { GraftError } from '@shared/errors';
import type { Db } from '../db/database';
import { nextRun, parseCron } from './cron';

/**
 * Recurring sessions: each schedule starts a new code session with its prompt
 * when its cron time comes, while Graft is running. Runs missed while the app
 * was closed are skipped; the next occurrence runs normally.
 */

export interface Schedule {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  projectPath: string;
  providerId: string | null;
  modelId: string | null;
  effort: EffortLevel | null;
  permissionMode: PermissionMode;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  createdAt: number;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  sessionId: string | null;
  startedAt: number;
  finishedAt: number | null;
  status: 'running' | 'waiting' | 'completed' | 'failed';
  error: string | null;
}

export interface ScheduleInput {
  name: string;
  cron: string;
  prompt: string;
  projectPath: string;
  providerId: string | null;
  modelId: string | null;
  effort: EffortLevel | null;
  permissionMode: PermissionMode;
  enabled: boolean;
}

interface Row {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  project_path: string;
  provider_id: string | null;
  model_id: string | null;
  effort: string | null;
  permission_mode: string;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
}

interface RunRow {
  id: string;
  schedule_id: string;
  session_id: string | null;
  started_at: number;
  finished_at: number | null;
  status: string;
  error: string | null;
}

function fromRow(r: Row): Schedule {
  return {
    id: r.id,
    name: r.name,
    cron: r.cron,
    prompt: r.prompt,
    projectPath: r.project_path,
    providerId: r.provider_id,
    modelId: r.model_id,
    effort: r.effort as EffortLevel | null,
    permissionMode: r.permission_mode as PermissionMode,
    enabled: r.enabled === 1,
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at,
    createdAt: r.created_at
  };
}

function runFromRow(r: RunRow): ScheduleRun {
  return {
    id: r.id,
    scheduleId: r.schedule_id,
    sessionId: r.session_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status as ScheduleRun['status'],
    error: r.error
  };
}

export interface SchedulerDeps {
  db: Db;
  /** Starts the session for a run and returns its id. */
  start(schedule: Schedule): Promise<string>;
  /** Current status of a started session (null when it no longer exists). */
  sessionStatus(sessionId: string): 'idle' | 'running' | 'needs-input' | 'error' | null;
  onChange(): void;
  log(level: 'info' | 'warn', message: string, fields?: Record<string, string>): void;
  now?: () => Date;
}

const TICK_MS = 30_000;

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly deps: SchedulerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  list(): Schedule[] {
    return (this.deps.db.prepare('SELECT * FROM schedules ORDER BY created_at').all() as Row[]).map(fromRow);
  }

  get(id: string): Schedule {
    const row = this.deps.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new GraftError('schedule_not_found', 'That schedule no longer exists.');
    return fromRow(row);
  }

  private validate(input: ScheduleInput): number | null {
    if (input.name.trim().length === 0) throw new GraftError('name_required', 'Give the schedule a name.');
    if (input.prompt.trim().length === 0) throw new GraftError('prompt_required', 'Write what the session should do.');
    if (!fs.existsSync(input.projectPath)) throw new GraftError('folder_missing', `The folder ${input.projectPath} doesn't exist.`);
    const next = nextRun(parseCron(input.cron), this.now());
    if (!next) throw new GraftError('invalid_cron', 'That schedule never runs.');
    return input.enabled ? next.getTime() : null;
  }

  create(input: ScheduleInput): Schedule {
    const next = this.validate(input);
    const id = randomUUID();
    this.deps.db
      .prepare(
        `INSERT INTO schedules (id, name, cron, prompt, project_path, provider_id, model_id, effort, permission_mode, enabled, last_run_at, next_run_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      )
      .run(id, input.name.trim(), input.cron.trim(), input.prompt.trim(), input.projectPath, input.providerId, input.modelId, input.effort, input.permissionMode, input.enabled ? 1 : 0, next, this.now().getTime());
    this.deps.onChange();
    return this.get(id);
  }

  update(id: string, input: ScheduleInput): Schedule {
    this.get(id);
    const next = this.validate(input);
    this.deps.db
      .prepare(
        `UPDATE schedules SET name = ?, cron = ?, prompt = ?, project_path = ?, provider_id = ?, model_id = ?, effort = ?, permission_mode = ?, enabled = ?, next_run_at = ? WHERE id = ?`
      )
      .run(input.name.trim(), input.cron.trim(), input.prompt.trim(), input.projectPath, input.providerId, input.modelId, input.effort, input.permissionMode, input.enabled ? 1 : 0, next, id);
    this.deps.onChange();
    return this.get(id);
  }

  setEnabled(id: string, enabled: boolean): Schedule {
    const s = this.get(id);
    const next = enabled ? (nextRun(parseCron(s.cron), this.now())?.getTime() ?? null) : null;
    this.deps.db.prepare('UPDATE schedules SET enabled = ?, next_run_at = ? WHERE id = ?').run(enabled ? 1 : 0, next, id);
    this.deps.onChange();
    return this.get(id);
  }

  remove(id: string): void {
    this.deps.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    this.deps.onChange();
  }

  runs(scheduleId: string, limit = 20): ScheduleRun[] {
    return (this.deps.db.prepare('SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT ?').all(scheduleId, limit) as RunRow[]).map(runFromRow);
  }

  /** Starts a run now (the "Run now" button, or when due). */
  async run(id: string): Promise<ScheduleRun> {
    const schedule = this.get(id);
    const runId = randomUUID();
    const startedAt = this.now().getTime();
    this.deps.db.prepare('INSERT INTO schedule_runs (id, schedule_id, session_id, started_at, finished_at, status, error) VALUES (?, ?, NULL, ?, NULL, ?, NULL)').run(runId, id, startedAt, 'running');
    this.deps.db.prepare('UPDATE schedules SET last_run_at = ? WHERE id = ?').run(startedAt, id);
    try {
      const sessionId = await this.deps.start(schedule);
      this.deps.db.prepare('UPDATE schedule_runs SET session_id = ? WHERE id = ?').run(sessionId, runId);
      this.deps.log('info', 'Scheduled session started', { schedule: schedule.name });
    } catch (error) {
      const message = (error as Error).message;
      this.deps.db.prepare('UPDATE schedule_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?').run('failed', message, this.now().getTime(), runId);
      this.deps.log('warn', 'Scheduled session failed to start', { schedule: schedule.name, message });
    }
    this.deps.onChange();
    return this.runs(id, 1)[0] ?? { id: runId, scheduleId: id, sessionId: null, startedAt, finishedAt: null, status: 'failed', error: null };
  }

  /** Starts due schedules and updates the status of unfinished runs. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const s of this.list()) {
        if (!s.enabled || s.nextRunAt === null || s.nextRunAt > now.getTime()) continue;
        const next = nextRun(parseCron(s.cron), now);
        this.deps.db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(next?.getTime() ?? null, s.id);
        await this.run(s.id);
      }
      this.refreshRuns();
    } finally {
      this.ticking = false;
    }
  }

  private refreshRuns(): void {
    const open = this.deps.db.prepare("SELECT * FROM schedule_runs WHERE status IN ('running', 'waiting') AND session_id IS NOT NULL").all() as RunRow[];
    let changed = false;
    for (const run of open) {
      const status = this.deps.sessionStatus(run.session_id ?? '');
      const next: ScheduleRun['status'] =
        status === null || status === 'error' ? 'failed' : status === 'idle' ? 'completed' : status === 'needs-input' ? 'waiting' : 'running';
      if (next === run.status) continue;
      changed = true;
      const finished = next === 'completed' || next === 'failed' ? this.now().getTime() : null;
      this.deps.db.prepare('UPDATE schedule_runs SET status = ?, finished_at = ?, error = ? WHERE id = ?').run(next, finished, status === null ? 'The session was deleted.' : null, run.id);
    }
    if (changed) this.deps.onChange();
  }

  /** Recomputes next runs from now (missed runs are skipped) and starts ticking. */
  start(): void {
    const now = this.now();
    for (const s of this.list()) {
      if (!s.enabled) continue;
      const next = nextRun(parseCron(s.cron), now);
      this.deps.db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(next?.getTime() ?? null, s.id);
    }
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => this.deps.log('warn', 'Scheduler tick failed', { message: (error as Error).message }));
    }, TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
