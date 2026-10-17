import { describe, expect, it } from 'vitest';
import { EFFORT_NOTICE_KEY, EFFORT_NOTICES, readPutAway } from '../../../src/renderer/src/features/composer/effortNoticeModel';
import { DEFAULT_DIFF_PREFS, readDiffPrefs } from '../../../src/renderer/src/features/panels/diffPrefs';
import { DEFAULT_TERMINAL_PREFS, readTerminalPrefs } from '../../../src/renderer/src/features/panels/terminalPrefs';
import { readDetails } from '../../../src/renderer/src/stores/details';

const storage = (values: Record<string, string>): Pick<Storage, 'getItem'> => ({ getItem: (key) => values[key] ?? null });

describe('the details column as it was left', () => {
  it('opens the first time with Context and Connectors folded', () => {
    expect(readDetails(null)).toEqual({ open: true, folded: ['context', 'connectors'], hidden: [] });
    expect(readDetails(storage({}))).toEqual({ open: true, folded: ['context', 'connectors'], hidden: [] });
  });

  it('comes back as it was left, keeping only cards it knows', () => {
    expect(readDetails(storage({ 'graft.details.v1': JSON.stringify({ open: false, folded: ['outputs', 'nonsense', 'tasks'] }) }))).toEqual({ open: false, folded: ['outputs', 'tasks'], hidden: [] });
  });

  it('keeps the cards taken out of it, in its order, and only cards it knows', () => {
    const kept = JSON.stringify({ open: true, folded: [], hidden: ['changes', 'nonsense', 'environment'] });
    expect(readDetails(storage({ 'graft.details.v1': kept }))).toEqual({ open: true, folded: [], hidden: ['environment', 'changes'] });
    expect(readDetails(storage({ 'graft.details.v1': JSON.stringify({ open: true, folded: [], hidden: 'all' }) })).hidden).toEqual([]);
  });

  it('opens as the first time when what was kept can’t be read', () => {
    expect(readDetails(storage({ 'graft.details.v1': '{not json' }))).toEqual({ open: true, folded: ['context', 'connectors'], hidden: [] });
    expect(readDetails(storage({ 'graft.details.v1': JSON.stringify({ open: 'yes', folded: 'all' }) }))).toEqual({ open: true, folded: ['context', 'connectors'], hidden: [] });
    expect(readDetails({ getItem: () => { throw new Error('blocked'); } })).toEqual({ open: true, folded: ['context', 'connectors'], hidden: [] });
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

describe('the terminal as it was set up', () => {
  it('starts with a blinking block and 5,000 lines kept', () => {
    expect(readTerminalPrefs(null)).toEqual(DEFAULT_TERMINAL_PREFS);
    expect(DEFAULT_TERMINAL_PREFS).toEqual({ cursorStyle: 'block', cursorBlink: true, copyOnSelect: false, scrollback: 5000 });
  });

  it('keeps each choice it can read, and the default for the rest', () => {
    const kept = (value: unknown) => readTerminalPrefs(storage({ 'graft.terminal.v1': JSON.stringify(value) }));
    expect(kept({ cursorStyle: 'bar', cursorBlink: false, copyOnSelect: true, scrollback: 50000 })).toEqual({ cursorStyle: 'bar', cursorBlink: false, copyOnSelect: true, scrollback: 50000 });
    expect(kept({ cursorStyle: 'beam', scrollback: 123, copyOnSelect: 'yes' })).toEqual(DEFAULT_TERMINAL_PREFS);
    expect(readTerminalPrefs(storage({ 'graft.terminal.v1': '[' }))).toEqual(DEFAULT_TERMINAL_PREFS);
  });
});

describe('the diff as it was set up', () => {
  it('is unified, unwrapped and with its whitespace until changed', () => {
    expect(readDiffPrefs(null)).toEqual(DEFAULT_DIFF_PREFS);
    expect(readDiffPrefs(storage({ 'graft.diff.v1': JSON.stringify({ split: true, wrap: 'no', ignoreWhitespace: true }) }))).toEqual({ split: true, wrap: false, ignoreWhitespace: true });
  });
});
