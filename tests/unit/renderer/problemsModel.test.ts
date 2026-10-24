import { describe, expect, it } from 'vitest';
import { checkingLabel, fixRequest, problemCount, problemsMessage, problemsTab, withRequest } from '../../../src/renderer/src/features/panels/problemsModel';
import type { ChangedProblems } from '../../../src/shared/schemas/semantic';

const p = (line: number, text = "Type 'string' is not assignable to type 'number'.") => ({ line, column: 5, severity: 'error' as const, code: 2322, text });
const result = (over: Partial<ChangedProblems>): ChangedProblems => ({ state: 'ok', checked: 0, files: [], unchecked: [], ...over });

describe('problems, as the panel says them', () => {
  it('counts them and writes the request to fix them', () => {
    const files = [{ path: 'src/a.ts', problems: [p(12), { ...p(20, 'Unused.'), severity: 'warning' as const, code: null }] }];
    expect(problemCount(result({ files }))).toBe(2);
    expect(problemCount(null)).toBe(0);
    expect(fixRequest(files)).toBe("Fix these problems:\n- src/a.ts:12:5 Type 'string' is not assignable to type 'number'. (2322)\n- src/a.ts:20:5 Unused.");
  });

  it('lists 30 at most and says how many more', () => {
    const lines = fixRequest([{ path: 'a.ts', problems: Array.from({ length: 34 }, (_, i) => p(i + 1)) }]).split('\n');
    expect(lines).toHaveLength(32);
    expect(lines.at(-1)).toBe('…and 4 more.');
  });

  it('says why there is nothing to list', () => {
    expect(problemsMessage(result({ checked: 3 }))).toBe('No problems in the 3 changed files that could be checked.');
    expect(problemsMessage(result({ checked: 1 }))).toBe('No problems in the 1 changed file that could be checked.');
    expect(problemsMessage(result({ state: 'none' }))).toBe('No changed TypeScript or JavaScript files.');
    expect(problemsMessage(result({ state: 'untrusted' }))).toBe('Problems need a trusted project.');
    expect(problemsMessage(result({ state: 'no-packages' }))).toBe("Install the project's packages to check it.");
    expect(problemsMessage(result({ checked: 0, unchecked: [{ path: 'a.ts', reason: 'x' }] }))).toBe('None of the changed files could be checked.');
    expect(problemsMessage(result({ checked: 1, files: [{ path: 'a.ts', problems: [p(1)] }] }))).toBeNull();
  });

  it('adds a request to what is already in the message box', () => {
    expect(withRequest('', 'Fix these problems:\n- a')).toBe('Fix these problems:\n- a');
    expect(withRequest('First this.  ', 'Fix these problems:\n- a')).toBe('First this.\n\nFix these problems:\n- a');
  });

  it('names its tab with the count once a check found any, and says how many files it is checking', () => {
    expect(problemsTab(0)).toBe('Problems');
    expect(problemsTab(3)).toBe('Problems (3)');
    expect(checkingLabel(null)).toBe('Checking…');
    expect(checkingLabel(1)).toBe('Checking 1 file…');
    expect(checkingLabel(7)).toBe('Checking 7 files…');
    expect(checkingLabel(80)).toBe('Checking 50 files…');
  });
});
