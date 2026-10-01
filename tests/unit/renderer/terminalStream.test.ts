import { describe, expect, it } from 'vitest';
import { sliceAfter, StreamJoiner } from '../../../src/renderer/src/features/panels/terminalStream';

describe('terminal stream joining', () => {
  it('keeps only the part of a chunk after a stream position', () => {
    expect(sliceAfter('hello', 0, 10)).toBe('');
    expect(sliceAfter('hello', 10, 10)).toBe('hello');
    expect(sliceAfter('hello', 8, 10)).toBe('llo');
  });

  it('merges a snapshot with chunks that arrived before and after it, without duplicates', () => {
    const out: string[] = [];
    const joiner = new StreamJoiner((d) => out.push(d));
    // Live chunks arrive while the snapshot request is in flight.
    joiner.chunk('abc', 0);
    joiner.chunk('def', 3);
    // The snapshot already contains "abcde" (it was taken mid-chunk).
    joiner.snapshot('abcde', 5);
    joiner.chunk('ghi', 6);
    joiner.chunk('ghi', 6);
    expect(out.join('')).toBe('abcdefghi');
  });
});
