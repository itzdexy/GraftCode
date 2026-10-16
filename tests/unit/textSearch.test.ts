import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { matchOf, MAX_MATCH_LINES, previewOf, searchArgs, searchText } from '../../src/main/files/textSearch';
import type { TextSearchQuery } from '../../src/shared/schemas/textSearch';
import { makeTempDir, removeDir, writeFile } from '../support/tmp';
import { RG_PATH } from '../support/toolContext';

const query = (text: string, more: Partial<TextSearchQuery> = {}): TextSearchQuery => ({ text, regex: false, caseSensitive: false, wholeWord: false, files: '', ...more });

describe('what ripgrep is asked', () => {
  it('looks for the text as it is written unless a pattern is asked for', () => {
    expect(searchArgs(query('a.b('))).toContain('--fixed-strings');
    expect(searchArgs(query('a.b', { regex: true }))).not.toContain('--fixed-strings');
  });

  it('passes the text as the pattern, never as an option', () => {
    const args = searchArgs(query('--files'));
    expect(args.slice(-4)).toEqual(['--regexp', '--files', '--', '.']);
  });

  it('ignores case unless asked not to, and matches whole words when asked', () => {
    expect(searchArgs(query('x'))).toContain('--ignore-case');
    expect(searchArgs(query('x', { caseSensitive: true }))).toContain('--case-sensitive');
    expect(searchArgs(query('x', { caseSensitive: true }))).not.toContain('--ignore-case');
    expect(searchArgs(query('x', { wholeWord: true }))).toContain('--word-regexp');
    expect(searchArgs(query('x'))).not.toContain('--word-regexp');
  });

  it('narrows to the files named, and leaves out the ones named with "!"', () => {
    const args = searchArgs(query('x', { files: ' src/**/*.ts, !**/*.test.ts ,, ' }));
    const globs = args.flatMap((arg, i) => (arg === '--glob' ? [args[i + 1]] : []));
    expect(globs).toEqual(['!.git', 'src/**/*.ts', '!**/*.test.ts']);
  });
});

describe('a line as a result shows it', () => {
  it('drops the indentation and moves the matches with it', () => {
    expect(previewOf('    const total = sum(items);', [[10, 15]])).toEqual({ text: 'const total = sum(items);', ranges: [[6, 11]] });
  });

  it('keeps indentation that is part of the match', () => {
    expect(previewOf('  x', [[0, 3]])).toEqual({ text: '  x', ranges: [[0, 3]] });
  });

  it('shows the part of a long line around its first match', () => {
    const line = `${'a'.repeat(500)}NEEDLE${'b'.repeat(500)}NEEDLE`;
    const shown = previewOf(line, [[500, 506], [1006, 1012]]);
    expect(shown.text.length).toBeLessThanOrEqual(242);
    expect(shown.text.startsWith('…')).toBe(true);
    expect(shown.text.endsWith('…')).toBe(true);
    // The first match is marked where it now is; the one beyond the cut is not listed.
    expect(shown.ranges).toHaveLength(1);
    const [start, end] = shown.ranges[0]!;
    expect(shown.text.slice(start, end)).toBe('NEEDLE');
  });

  it('cuts a match that runs past the end of what is shown', () => {
    const line = `x${'N'.repeat(600)}`;
    const shown = previewOf(line, [[1, 601]]);
    const [start, end] = shown.ranges[0]!;
    expect(start).toBe(1);
    expect(end).toBe(shown.text.length - 1);
    expect(shown.text.endsWith('…')).toBe(true);
  });
});

describe("ripgrep's answer", () => {
  const event = (lines: object, submatches: Array<{ start: number; end: number }>, path: object = { text: '.\\src\\app\\naïve.ts' }) => ({
    type: 'match',
    data: { path, lines, line_number: 7, submatches: submatches.map((s) => ({ match: { text: '' }, ...s })) }
  });

  it('counts in characters where ripgrep counts in bytes', () => {
    // "héllo" starts at byte 16 and character 15: "ï" before it is two bytes.
    const found = matchOf(event({ text: 'const naïve = "héllo wörld"; // héllo again\n' }, [{ start: 16, end: 22 }, { start: 35, end: 41 }]));
    expect(found).toEqual({
      path: 'src/app/naïve.ts',
      match: { line: 7, column: 16, text: 'const naïve = "héllo wörld"; // héllo again', ranges: [[15, 20], [32, 37]] }
    });
  });

  it('leaves the end of the line out, whichever kind it is', () => {
    expect(matchOf(event({ text: 'second hello\r\n' }, [{ start: 7, end: 12 }]))?.match.text).toBe('second hello');
  });

  it('reads a line and a path that are not valid text', () => {
    const bytes = Buffer.concat([Buffer.from('caf'), Buffer.from([0xe9]), Buffer.from(' hello\n')]);
    const found = matchOf(event({ bytes: bytes.toString('base64') }, [{ start: 5, end: 10 }], { bytes: Buffer.from('./notes.txt').toString('base64') }));
    expect(found?.path).toBe('notes.txt');
    expect(found?.match.text).toBe('caf� hello');
    expect(found?.match.ranges).toEqual([[5, 10]]);
  });

  it('is nothing for what is not a match', () => {
    expect(matchOf({ type: 'begin', data: { path: { text: 'a.ts' } } })).toBeNull();
    expect(matchOf({ type: 'match', data: {} })).toBeNull();
    expect(matchOf('nonsense')).toBeNull();
  });
});

describe('a search of a folder', () => {
  let root: string;
  beforeAll(() => {
    root = makeTempDir('graft search (tmp) ');
    writeFile(root, 'src/app.ts', 'export const total = 1;\n  // Total of the order\nconst subtotal = total - 1;\n');
    writeFile(root, 'src/lib/money.ts', 'export function total(items: number[]): number {\n  return items.length;\n}\n');
    writeFile(root, 'docs/notes.md', '# Notes\n\nThe total is shown --last.\n');
    writeFile(root, '.gitignore', 'build/\n');
    writeFile(root, 'build/out.js', 'var total = 1;\n');
    writeFile(root, '.git/config', 'total = yes\n');
    writeFile(root, 'many.txt', `${Array.from({ length: MAX_MATCH_LINES + 500 }, (_, i) => `needle ${String(i)}`).join('\n')}\n`);
  });
  afterAll(() => removeDir(root));

  const run = (text: string, more: Partial<TextSearchQuery> = {}) => searchText(RG_PATH, root, query(text, more));

  it('lists the lines by file, in the order of their paths, and skips what git ignores', async () => {
    const result = await run('total');
    expect(result.files.map((file) => file.path)).toEqual(['docs/notes.md', 'src/app.ts', 'src/lib/money.ts']);
    expect(result.files[1]?.matches.map((match) => [match.line, match.column, match.text])).toEqual([
      [1, 14, 'export const total = 1;'],
      [2, 6, '// Total of the order'],
      [3, 10, 'const subtotal = total - 1;']
    ]);
    // Both matches on the last line are marked.
    expect(result.files[1]?.matches[2]?.ranges).toEqual([[9, 14], [17, 22]]);
    expect(result.lines).toBe(5);
    expect(result.truncated).toBe(false);
  });

  it('matches case and whole words when asked', async () => {
    expect((await run('Total', { caseSensitive: true })).lines).toBe(1);
    const whole = await run('total', { wholeWord: true });
    expect(whole.files[1]?.matches[2]?.ranges).toEqual([[17, 22]]);
  });

  it('takes a pattern when asked, and the text as written otherwise', async () => {
    expect((await run('items\\.\\w+', { regex: true })).files[0]?.matches[0]?.text).toBe('return items.length;');
    expect((await run('number[]')).lines).toBe(1);
    expect((await run('--last')).lines).toBe(1);
  });

  it('narrows to the files asked for', async () => {
    expect((await run('total', { files: '*.md' })).files.map((file) => file.path)).toEqual(['docs/notes.md']);
    expect((await run('total', { files: 'src/**, !**/lib/**' })).files.map((file) => file.path)).toEqual(['src/app.ts']);
  });

  it('skips what a .gitignore names in a folder that is not a repository', async () => {
    const plain = makeTempDir('graft search plain (tmp) ');
    try {
      writeFile(plain, '.gitignore', 'node_modules/\n');
      writeFile(plain, 'node_modules/pkg/index.js', 'module.exports = "total";\n');
      writeFile(plain, 'index.js', 'const total = 1;\n');
      expect((await searchText(RG_PATH, plain, query('total'))).files.map((file) => file.path)).toEqual(['index.js']);
    } finally {
      removeDir(plain);
    }
  });

  it('finds nothing without failing', async () => {
    expect(await run('no such text anywhere')).toEqual({ files: [], lines: 0, truncated: false });
  });

  it('stops at its limit and says there is more', async () => {
    const result = await run('needle');
    expect(result.lines).toBe(MAX_MATCH_LINES);
    expect(result.truncated).toBe(true);
  });

  it('says what is wrong with a pattern that cannot be read', async () => {
    await expect(run('(total', { regex: true })).rejects.toThrow(/unclosed group/);
    await expect(run('(total', { regex: true })).rejects.toMatchObject({ code: 'bad_pattern' });
  });

  it('ends when it is told to stop', async () => {
    const stop = new AbortController();
    stop.abort();
    const result = await searchText(RG_PATH, root, query('needle'), stop.signal);
    expect(result.truncated).toBe(true);
  });
});
