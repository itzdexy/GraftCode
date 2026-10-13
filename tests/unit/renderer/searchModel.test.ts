import { describe, expect, it } from 'vitest';
import { pieces, resultsText, searchSummary, seedFromSelection } from '../../../src/renderer/src/features/panels/searchModel';
import type { TextSearchQuery, TextSearchResult } from '../../../src/shared/schemas/textSearch';

const query = (text: string, more: Partial<TextSearchQuery> = {}): TextSearchQuery => ({ text, regex: false, caseSensitive: false, wholeWord: false, files: '', ...more });
const line = (n: number, text: string, ranges: Array<[number, number]> = []) => ({ line: n, column: 1, text, ranges });

const found: TextSearchResult = {
  files: [
    { path: 'src/app.ts', matches: [line(1, 'export const total = 1;', [[13, 18]]), line(3, 'const subtotal = total - 1;', [[9, 14], [17, 22]])] },
    { path: 'src/lib/money.ts', matches: [line(1, 'export function total(items: number[]): number {', [[16, 21]])] }
  ],
  lines: 3,
  truncated: false
};

describe('what a search says it found', () => {
  it('counts the lines and the files', () => {
    expect(searchSummary(found)).toBe('3 lines in 2 files');
    expect(searchSummary({ files: [{ path: 'a.ts', matches: [line(1, 'x')] }], lines: 1, truncated: false })).toBe('1 line in 1 file');
  });

  it('says so when there is nothing', () => {
    expect(searchSummary({ files: [], lines: 0, truncated: false })).toBe('No results');
  });

  it('never reads as complete when the search was stopped', () => {
    expect(searchSummary({ ...found, lines: 2000, truncated: true })).toBe('The first 2,000 lines, in 2 files. There are more: narrow the search.');
    expect(searchSummary({ files: [], lines: 0, truncated: true })).toBe('The search was stopped before it found anything.');
  });
});

describe('a line in pieces', () => {
  it('marks what matched and leaves the rest', () => {
    expect(pieces('const subtotal = total - 1;', [[9, 14], [17, 22]])).toEqual([
      { text: 'const sub', hit: false },
      { text: 'total', hit: true },
      { text: ' = ', hit: false },
      { text: 'total', hit: true },
      { text: ' - 1;', hit: false }
    ]);
  });

  it('is one plain piece without matches, and nothing for an empty line', () => {
    expect(pieces('plain', [])).toEqual([{ text: 'plain', hit: false }]);
    expect(pieces('', [])).toEqual([]);
  });

  it('survives ranges that overlap, come out of order or reach past the end', () => {
    expect(pieces('abcdef', [[4, 99], [1, 3], [2, 5]])).toEqual([
      { text: 'a', hit: false },
      { text: 'bcdef', hit: true }
    ]);
  });
});

describe('the results as text for the agent', () => {
  it('names what was looked for and lists each line under its file', () => {
    expect(resultsText(query('total'), found)).toBe(
      ['Search in the project for "total"', '3 lines in 2 files', '', 'src/app.ts', '  1: export const total = 1;', '  3: const subtotal = total - 1;', '', 'src/lib/money.ts', '  1: export function total(items: number[]): number {'].join('\n')
    );
  });

  it('says how it looked', () => {
    const head = resultsText(query('to+tal', { regex: true, caseSensitive: true, wholeWord: true, files: 'src/**' }), found).split('\n')[0];
    expect(head).toBe('Search in the project for the pattern "to+tal" (case matched, whole words, in src/**)');
  });

  it('lists no more than its limit and counts the rest', () => {
    const text = resultsText(query('total'), found, 2);
    expect(text).toContain('  3: const subtotal = total - 1;');
    expect(text).not.toContain('money.ts');
    expect(text.endsWith('…and 1 more line.')).toBe(true);
  });

  it('covers a line that holds a key', () => {
    const secret: TextSearchResult = { files: [{ path: '.env', matches: [line(2, 'API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ', [[0, 7]])] }], lines: 1, truncated: false };
    const text = resultsText(query('API_KEY'), secret);
    expect(text).toContain('.env');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });
});

describe('text that is selected when the search opens', () => {
  it('becomes what is looked for when it is one short line', () => {
    expect(seedFromSelection('  parseAccelerator ')).toBe('parseAccelerator');
  });

  it('is left alone when it runs over lines, is empty or is long', () => {
    expect(seedFromSelection('two\nlines')).toBeNull();
    expect(seedFromSelection('   ')).toBeNull();
    expect(seedFromSelection('x'.repeat(201))).toBeNull();
  });
});
