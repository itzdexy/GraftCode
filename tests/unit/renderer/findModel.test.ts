import { describe, expect, it } from 'vitest';
import { countLabel, findMatches, stepMatch } from '../../../src/renderer/src/features/session/findModel';

describe('finding text in what the transcript shows', () => {
  it('ignores case and finds every place, one after another', () => {
    expect(findMatches([['Hello hello'], ['HELLO']], 'hello')).toEqual({
      matches: [
        { start: { node: 0, offset: 0 }, end: { node: 0, offset: 5 } },
        { start: { node: 0, offset: 6 }, end: { node: 0, offset: 11 } },
        { start: { node: 1, offset: 0 }, end: { node: 1, offset: 5 } }
      ],
      more: false
    });
    expect(findMatches([['aaaa']], 'aa').matches).toHaveLength(2);
    expect(findMatches([['Straße']], 'STRASSE').matches).toEqual([]);
  });

  it('finds words that are drawn in several pieces, but never across two blocks', () => {
    expect(findMatches([['const', ' ', 'answer', ' = 42']], 'const answer').matches).toEqual([{ start: { node: 0, offset: 0 }, end: { node: 2, offset: 6 } }]);
    expect(findMatches([['one'], ['two']], 'onetwo').matches).toEqual([]);
    expect(findMatches([['x'], ['', 'ab', 'c']], 'bc').matches).toEqual([{ start: { node: 2, offset: 1 }, end: { node: 3, offset: 1 } }]);
    // A match that begins where one piece ends begins in the next piece, and one that ends there ends in the first.
    expect(findMatches([['const', ' ', 'answer']], 'answer').matches).toEqual([{ start: { node: 2, offset: 0 }, end: { node: 2, offset: 6 } }]);
    expect(findMatches([['const', '', ' ', 'answer']], 'const').matches).toEqual([{ start: { node: 0, offset: 0 }, end: { node: 0, offset: 5 } }]);
  });

  it('takes what was typed as text, not as a pattern', () => {
    expect(findMatches([['a.c abc']], 'a.c').matches).toHaveLength(1);
    expect(findMatches([['(x)']], '(x').matches).toHaveLength(1);
  });

  it('keeps its places right beside a letter whose lower case is longer', () => {
    // "İ" becomes two characters in lower case; the places after it must still be the text's own.
    expect(findMatches([['İ abc']], 'ABC').matches).toEqual([{ start: { node: 0, offset: 2 }, end: { node: 0, offset: 5 } }]);
  });

  it('finds nothing for nothing, and stops at the limit', () => {
    expect(findMatches([['abc']], '')).toEqual({ matches: [], more: false });
    const many = findMatches([Array.from({ length: 1500 }, () => 'a ')], 'a');
    expect(many.matches).toHaveLength(1000);
    expect(many.more).toBe(true);
    expect(findMatches([['a a a']], 'a', 2)).toMatchObject({ more: true });
    expect(findMatches([['a a']], 'a', 2)).toMatchObject({ more: false });
  });

  it('counts in words and steps round', () => {
    expect(countLabel(2, 17, false)).toBe('3 of 17');
    expect(countLabel(0, 0, false)).toBe('No results');
    expect(countLabel(0, 1000, true)).toBe('1,000+');
    expect(stepMatch(16, 17, 1)).toBe(0);
    expect(stepMatch(0, 17, -1)).toBe(16);
    expect(stepMatch(0, 0, 1)).toBe(0);
  });
});
