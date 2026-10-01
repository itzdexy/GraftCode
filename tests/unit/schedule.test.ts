import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/main/db/database';
import { describeCron, nextRun, parseCron } from '../../src/main/schedule/cron';
import { Scheduler, type ScheduleInput } from '../../src/main/schedule/scheduler';
import { makeTempDir, removeDir } from '../support/tmp';

const at = (y: number, mo: number, d: number, h: number, mi: number): Date => new Date(y, mo - 1, d, h, mi, 0, 0);
const next = (expr: string, from: Date): Date | null => nextRun(parseCron(expr), from);

describe('cron', () => {
  it('finds the next matching minute in local time', () => {
    const wed = at(2026, 9, 30, 10, 15); // Wednesday
    expect(next('0 * * * *', wed)).toEqual(at(2026, 9, 30, 11, 0));
    expect(next('*/15 * * * *', wed)).toEqual(at(2026, 9, 30, 10, 30));
    expect(next('30 9 * * *', wed)).toEqual(at(2026, 10, 1, 9, 30));
    expect(next('0 9 * * 1-5', at(2026, 10, 2, 10, 0))).toEqual(at(2026, 10, 5, 9, 0)); // Fri → Mon
    expect(next('0 9 * * sun', wed)).toEqual(at(2026, 10, 4, 9, 0));
    expect(next('0 9 * * 7', wed)).toEqual(at(2026, 10, 4, 9, 0));
    expect(next('0 0 1 jan *', wed)).toEqual(at(2027, 1, 1, 0, 0));
    expect(next('0 12 29 2 *', wed)).toEqual(at(2028, 2, 29, 12, 0));
  });

  it('matches either day field when both are restricted, like cron', () => {
    // The 1st of the month OR any Friday.
    expect(next('0 8 1 * 5', at(2026, 9, 30, 9, 0))).toEqual(at(2026, 10, 1, 8, 0));
    expect(next('0 8 1 * 5', at(2026, 10, 1, 9, 0))).toEqual(at(2026, 10, 2, 8, 0));
  });

  it('rejects malformed expressions and impossible dates', () => {
    expect(() => parseCron('* * * *')).toThrow(/five fields/);
    expect(() => parseCron('60 * * * *')).toThrow(/out of range/);
    expect(() => parseCron('*/0 * * * *')).toThrow(/step/);
    expect(() => parseCron('x * * * *')).toThrow(/not a number/);
    expect(next('0 0 31 2 *', at(2026, 1, 1, 0, 0))).toBeNull();
  });

  it('describes common schedules', () => {
    expect(describeCron('0 * * * *')).toBe('Every hour');
    expect(describeCron('15 * * * *')).toBe('Every hour at :15');
    expect(describeCron('30 9 * * *')).toBe('Every day at 09:30');
    expect(describeCron('0 9 * * 1-5')).toBe('Weekdays at 09:00');
    expect(describeCron('0 18 * * 5')).toBe('Every Friday at 18:00');
    expect(describeCron('0 9 1 * *')).toBe('0 9 1 * *');
  });
});

describe('scheduler', () => {
  let db: Db;
  let dir: string;
  afterEach(() => {
    db.close();
    removeDir(dir);
  });

  function make(now: { value: Date }, status: Map<string, 'idle' | 'running' | 'needs-input' | 'error'>) {
    dir = makeTempDir();
    db = openDatabase(path.join(dir, 'graft.db'));
    const started: string[] = [];
    const scheduler = new Scheduler({
      db,
      start: (s) => {
        started.push(s.name);
        const id = `session-${started.length}`;
        status.set(id, 'running');
        return Promise.resolve(id);
      },
      sessionStatus: (id) => status.get(id) ?? null,
      onChange: () => undefined,
      log: () => undefined,
      now: () => now.value
    });
    return { scheduler, started };
  }

  const input = (over: Partial<ScheduleInput> = {}): ScheduleInput => ({
    name: 'Nightly check',
    cron: '0 2 * * *',
    prompt: 'Run the tests and report failures.',
    projectPath: dir,
    providerId: null,
    modelId: null,
    effort: null,
    permissionMode: 'ask',
    enabled: true,
    ...over
  });

  it('runs due schedules once, tracks their sessions and skips runs missed while closed', async () => {
    const now = { value: at(2026, 9, 30, 1, 0) };
    const status = new Map<string, 'idle' | 'running' | 'needs-input' | 'error'>();
    const { scheduler, started } = make(now, status);
    const s = scheduler.create(input());
    expect(s.nextRunAt).toBe(at(2026, 9, 30, 2, 0).getTime());

    await scheduler.tick();
    expect(started).toEqual([]);

    now.value = at(2026, 9, 30, 2, 0);
    await scheduler.tick();
    await scheduler.tick();
    expect(started).toEqual(['Nightly check']);
    expect(scheduler.get(s.id).nextRunAt).toBe(at(2026, 10, 1, 2, 0).getTime());
    expect(scheduler.runs(s.id)[0]).toMatchObject({ sessionId: 'session-1', status: 'running' });

    status.set('session-1', 'needs-input');
    await scheduler.tick();
    expect(scheduler.runs(s.id)[0]?.status).toBe('waiting');
    status.set('session-1', 'idle');
    await scheduler.tick();
    expect(scheduler.runs(s.id)[0]).toMatchObject({ status: 'completed' });
    expect(scheduler.runs(s.id)[0]?.finishedAt).not.toBeNull();

    // App restarted days later: missed runs are skipped, the next one is in the future.
    now.value = at(2026, 10, 5, 12, 0);
    scheduler.start();
    scheduler.stop();
    expect(scheduler.get(s.id).nextRunAt).toBe(at(2026, 10, 6, 2, 0).getTime());
    await scheduler.tick();
    expect(started).toHaveLength(1);
  });

  it('validates input and supports run now, disable and delete', async () => {
    const now = { value: at(2026, 9, 30, 1, 0) };
    const { scheduler, started } = make(now, new Map());
    expect(() => scheduler.create(input({ cron: 'bad' }))).toThrow();
    expect(() => scheduler.create(input({ prompt: ' ' }))).toThrow(/Write what/);
    expect(() => scheduler.create(input({ projectPath: path.join(dir, 'missing') }))).toThrow(/doesn't exist/);
    const s = scheduler.create(input());
    await scheduler.run(s.id);
    expect(started).toEqual(['Nightly check']);
    expect(scheduler.setEnabled(s.id, false).nextRunAt).toBeNull();
    now.value = at(2026, 9, 30, 2, 0);
    await scheduler.tick();
    expect(started).toHaveLength(1);
    scheduler.remove(s.id);
    expect(scheduler.list()).toEqual([]);
  });
});
