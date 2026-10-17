import { describe, expect, it } from 'vitest';
import { EFFORT_NOTICE_KEY, EFFORT_NOTICES, readPutAway } from '../../../src/renderer/src/features/composer/effortNoticeModel';
import { readDetails } from '../../../src/renderer/src/stores/details';

const storage = (values: Record<string, string>): Pick<Storage, 'getItem'> => ({ getItem: (key) => values[key] ?? null });

describe('the details column as it was left', () => {
  it('opens the first time with Context and Connectors folded', () => {
    expect(readDetails(null)).toEqual({ open: true, folded: ['context', 'connectors'] });
    expect(readDetails(storage({}))).toEqual({ open: true, folded: ['context', 'connectors'] });
  });

  it('comes back as it was left, keeping only cards it knows', () => {
    expect(readDetails(storage({ 'graft.details.v1': JSON.stringify({ open: false, folded: ['outputs', 'nonsense', 'tasks'] }) }))).toEqual({ open: false, folded: ['outputs', 'tasks'] });
  });

  it('opens as the first time when what was kept can’t be read', () => {
    expect(readDetails(storage({ 'graft.details.v1': '{not json' }))).toEqual({ open: true, folded: ['context', 'connectors'] });
    expect(readDetails(storage({ 'graft.details.v1': JSON.stringify({ open: 'yes', folded: 'all' }) }))).toEqual({ open: true, folded: ['context', 'connectors'] });
    expect(readDetails({ getItem: () => { throw new Error('blocked'); } })).toEqual({ open: true, folded: ['context', 'connectors'] });
  });
});

describe('the notice at the deepest efforts', () => {
  it('is said at Max and Taproot only, without promising a multiplier', () => {
    expect(Object.keys(EFFORT_NOTICES).sort()).toEqual(['max', 'taproot']);
    for (const text of Object.values(EFFORT_NOTICES)) expect(text).not.toMatch(/\d(\.\d+)?×/);
  });

  it('stays put away for the levels it was closed for', () => {
    expect(readPutAway(null)).toEqual([]);
    expect(readPutAway(storage({ [EFFORT_NOTICE_KEY]: JSON.stringify(['max', 'medium', 7]) }))).toEqual(['max']);
    expect(readPutAway(storage({ [EFFORT_NOTICE_KEY]: 'nope' }))).toEqual([]);
  });
});
