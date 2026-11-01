import { describe, expect, it } from 'vitest';
import { mentionSuggestions, pathQuery } from '../../../src/renderer/src/features/composer/suggestions';

const rows = (query: string, paths: string[] = []): Array<[string, string | undefined, string]> => mentionSuggestions(query, paths).map((s) => [s.label, s.kind, s.insert]);

describe('the "@" menu', () => {
  it('offers the words and a web page first, then folders and files', () => {
    expect(rows('', ['src/', 'README.md'])).toEqual([
      ['@diff', 'diff', '@diff '],
      ['@problems', 'problems', '@problems '],
      ['@terminal', 'terminal', '@terminal '],
      ['@url', 'url', '@https://'],
      ['src/', 'folder', '@src/ '],
      ['README.md', 'file', '@README.md ']
    ]);
    // Typed text narrows the words to those it starts.
    expect(rows('p', ['src/app.ts'])).toEqual([
      ['@problems', 'problems', '@problems '],
      ['src/app.ts', 'file', '@src/app.ts ']
    ]);
  });

  it('turns a typed address into one row that attaches the page', () => {
    expect(rows('https://example.com/docs', ['ignored.ts'])).toEqual([['https://example.com/docs', 'url', '@https://example.com/docs ']]);
  });

  it('keeps lines typed after a path with the files it matches, quoting a path with a space', () => {
    expect(pathQuery('src/app.ts:10-40')).toBe('src/app.ts');
    expect(pathQuery('src/app.ts:10-')).toBe('src/app.ts');
    expect(rows('src/app.ts:10-40', ['src/', 'src/app.ts', 'my docs/app.ts'])).toEqual([
      ['src/app.ts:10-40', 'file', '@src/app.ts:10-40 '],
      ['my docs/app.ts:10-40', 'file', '@"my docs/app.ts:10-40" ']
    ]);
  });
});
