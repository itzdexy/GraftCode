import { describe, expect, it } from 'vitest';
import { durationMs, flipMoves } from '../../../src/renderer/src/lib/flip';

const at = (entries: Array<[string, number]>): Map<string, number> => new Map(entries);

describe('rows that changed place', () => {
  it('travel from where they were, and rows that stayed or are new do not', () => {
    const before = at([['a', 0], ['b', 25], ['c', 50]]);
    const after = at([['c', 0], ['a', 25], ['b', 50], ['d', 75]]);
    expect(flipMoves(before, after)).toEqual([{ key: 'c', dy: 50 }, { key: 'a', dy: -25 }, { key: 'b', dy: -25 }]);
    expect(flipMoves(before, before)).toEqual([]);
    expect(flipMoves(at([]), after)).toEqual([]);
  });

  it('do not travel too far, or all at once', () => {
    expect(flipMoves(at([['a', 0], ['b', 700]]), at([['a', 700], ['b', 0]]))).toEqual([]);
    expect(flipMoves(at([['a', 0], ['b', 500]]), at([['a', 650], ['b', 0]]))).toEqual([{ key: 'b', dy: 500 }]);
    const many = Array.from({ length: 31 }, (_, i): [string, number] => [`r${String(i)}`, i * 25]);
    expect(flipMoves(at(many), at(many.map(([key, y]) => [key, y + 25])))).toEqual([]);
    expect(flipMoves(at(many.slice(0, 30)), at(many.slice(0, 30).map(([key, y]) => [key, y + 25])))).toHaveLength(30);
  });

  it('do not travel for less than a pixel: that is rounding, not a move', () => {
    expect(flipMoves(at([['a', 10]]), at([['a', 10.4]]))).toEqual([]);
  });

  it('reads a time from a token', () => {
    expect([durationMs('180ms'), durationMs(' 0.25s '), durationMs('0ms'), durationMs(''), durationMs('fast')]).toEqual([180, 250, 0, 0, 0]);
  });
});
