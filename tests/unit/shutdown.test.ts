import { describe, expect, it } from 'vitest';
import { runStages } from '../../src/main/app/shutdown';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('quitting in stages', () => {
  it('runs every stage in order, one after the other, and says how each ended', async () => {
    const seen: string[] = [];
    const reports = await runStages([
      { name: 'first', limitMs: 1000, run: async () => { seen.push('first starts'); await wait(20); seen.push('first ends'); } },
      { name: 'second', limitMs: 1000, run: () => { seen.push('second'); } },
      { name: 'nothing to do', limitMs: 1000, run: () => undefined }
    ]);
    expect(seen).toEqual(['first starts', 'first ends', 'second']);
    expect(reports.map((r) => [r.stage, r.outcome, r.error])).toEqual([['first', 'done', null], ['second', 'done', null], ['nothing to do', 'done', null]]);
    expect(reports[0]!.ms).toBeGreaterThanOrEqual(15);
  });

  it('goes on to the later stages when one fails, and reports the failure', async () => {
    const seen: string[] = [];
    const reports = await runStages([
      { name: 'servers', limitMs: 1000, run: () => Promise.reject(new Error('pipe closed')) },
      // Before, a failure here meant the commands below were never stopped and the database never closed.
      { name: 'commands', limitMs: 1000, run: () => { seen.push('commands stopped'); } },
      { name: 'throws at once', limitMs: 1000, run: () => { throw new Error('not a promise'); } },
      { name: 'database', limitMs: 1000, run: () => { seen.push('database closed'); } }
    ]);
    expect(seen).toEqual(['commands stopped', 'database closed']);
    expect(reports.map((r) => [r.stage, r.outcome, r.error])).toEqual([
      ['servers', 'failed', 'pipe closed'],
      ['commands', 'done', null],
      ['throws at once', 'failed', 'not a promise'],
      ['database', 'done', null]
    ]);
  });

  it('leaves a stage that does not finish in its time, so that one stuck part cannot keep the app open', async () => {
    const seen: string[] = [];
    const startedAt = Date.now();
    const reports = await runStages([
      { name: 'stuck', limitMs: 40, run: () => new Promise<void>(() => undefined) },
      { name: 'after', limitMs: 1000, run: () => { seen.push('after'); } }
    ]);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(seen).toEqual(['after']);
    expect(reports.map((r) => [r.stage, r.outcome])).toEqual([['stuck', 'timed out'], ['after', 'done']]);
    expect(reports[0]!.ms).toBeGreaterThanOrEqual(35);
  });

  it('does not mind a stage that fails after it was given up on', async () => {
    const reports = await runStages([
      { name: 'late failure', limitMs: 20, run: async () => { await wait(60); throw new Error('too late to matter'); } },
      { name: 'after', limitMs: 1000, run: () => undefined }
    ]);
    await wait(80);
    expect(reports.map((r) => r.outcome)).toEqual(['timed out', 'done']);
  });
});
