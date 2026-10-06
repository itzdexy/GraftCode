import { describe, expect, it } from 'vitest';
import { linesOf, missionMarkdown, missionStartFrom, missionStatusLine } from '../../../src/renderer/src/features/session/missionModel';
import type { Mission } from '../../../src/shared/schemas/missions';

function mission(extra: Partial<Mission> = {}): Mission {
  return {
    id: 'm1',
    sessionId: 's',
    objective: 'Add rate limiting',
    criteria: ['Returns 429 past the limit'],
    checks: ['npm test'],
    status: 'active',
    reason: null,
    turns: 3,
    maxTurns: 25,
    claimed: false,
    result: '',
    notebook: [],
    verification: null,
    createdAt: 1,
    updatedAt: 1,
    endedAt: null,
    rev: 0,
    ...extra
  };
}

describe('starting a mission from the form', () => {
  it('reads one criterion or command per line, dropping blank lines and repeats', () => {
    expect(linesOf('  npm test \n\n npm run lint\nnpm test\n')).toEqual(['npm test', 'npm run lint']);
    expect(linesOf('')).toEqual([]);
  });

  it('builds what is sent to start it', () => {
    expect(missionStartFrom({ objective: ' Add rate limiting ', criteria: 'Returns 429\n', checks: 'npm test', maxTurns: '20' })).toEqual({
      ok: true,
      start: { objective: 'Add rate limiting', criteria: ['Returns 429'], checks: ['npm test'], maxTurns: 20 }
    });
  });

  it('says what is wrong instead of sending something that would be refused', () => {
    expect(missionStartFrom({ objective: '  ', criteria: '', checks: '', maxTurns: '20' })).toEqual({ ok: false, field: 'objective', message: 'Say what the mission should achieve.' });
    expect(missionStartFrom({ objective: 'x', criteria: '', checks: '', maxTurns: 'lots' })).toMatchObject({ ok: false, field: 'maxTurns' });
    expect(missionStartFrom({ objective: 'x', criteria: '', checks: '', maxTurns: '0' })).toMatchObject({ ok: false, field: 'maxTurns' });
    expect(missionStartFrom({ objective: 'x', criteria: '', checks: '', maxTurns: '201' })).toMatchObject({ ok: false, field: 'maxTurns' });
    const many = Array.from({ length: 7 }, (_, i) => `cmd ${String(i)}`).join('\n');
    expect(missionStartFrom({ objective: 'x', criteria: '', checks: many, maxTurns: '5' })).toMatchObject({ ok: false, field: 'checks' });
    const criteria = Array.from({ length: 13 }, (_, i) => `criterion ${String(i)}`).join('\n');
    expect(missionStartFrom({ objective: 'x', criteria, checks: '', maxTurns: '5' })).toMatchObject({ ok: false, field: 'criteria' });
  });
});

describe('what the mission bar says', () => {
  it('counts the turns while it works, and says when the checks are running or about to', () => {
    expect(missionStatusLine(mission(), false)).toBe('Turn 3 of 25');
    expect(missionStatusLine(mission({ claimed: true }), false)).toBe('Reported done · the checks run next');
    expect(missionStatusLine(mission({ claimed: true }), true)).toBe('Running the checks');
    expect(missionStatusLine(mission({ claimed: true, checks: [] }), false)).toBe('Reported done');
  });

  it('says why it is paused', () => {
    expect(missionStatusLine(mission({ status: 'paused', reason: 'You paused it.' }), false)).toBe('Paused · You paused it.');
    expect(missionStatusLine(mission({ status: 'paused', reason: null }), false)).toBe('Paused');
  });

  it('says how it ended', () => {
    expect(missionStatusLine(mission({ status: 'done', turns: 7, verification: { passed: true, round: 1, runs: [] } }), false)).toBe('Done in 7 turns · checks passed');
    expect(missionStatusLine(mission({ status: 'done', turns: 1, checks: [] }), false)).toBe('Done in 1 turn');
    expect(missionStatusLine(mission({ status: 'cancelled' }), false)).toBe('Stopped after 3 turns');
  });
});

describe('a mission as Markdown', () => {
  it('has the objective, what done means, the checks and how they went, the result and the notebook', () => {
    const text = missionMarkdown(
      mission({
        status: 'done',
        turns: 4,
        result: 'The limiter is in.',
        notebook: [
          { kind: 'decision', text: 'Token bucket.', at: 10 },
          { kind: 'discovery', text: 'Routes live in src/routes.', at: 20 }
        ],
        verification: { passed: true, round: 2, runs: [{ command: 'npm test', exitCode: 0, output: 'ok', truncated: false, durationMs: 1200, timedOut: false, passed: true }] }
      })
    );
    expect(text).toContain('# Mission: Add rate limiting');
    expect(text).toContain('Done in 4 turns · checks passed');
    expect(text).toContain('- Returns 429 past the limit');
    expect(text).toContain('- `npm test`: passed');
    expect(text).toContain('The limiter is in.');
    expect(text).toContain('- **decision**: Token bucket.');
    expect(text).toContain('- **discovery**: Routes live in src/routes.');
  });

  it('leaves out the parts a mission does not have', () => {
    const text = missionMarkdown(mission({ criteria: [], checks: [], notebook: [] }));
    expect(text).not.toContain('## Done means');
    expect(text).not.toContain('## Checks');
    expect(text).not.toContain('## Notebook');
    expect(text).not.toContain('## Result');
  });
});
