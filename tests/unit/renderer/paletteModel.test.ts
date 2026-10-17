import { describe, expect, it, vi } from 'vitest';
import { anchorFile, fileQuery, fileRow, filesShown, latestOnly, paletteInput, symbolMessage } from '../../../src/renderer/src/features/shell/paletteModel';
import { symbolKind } from '../../../src/shared/symbolKinds';

describe('what the palette is looking for', () => {
  it('turns from files to commands with ">" and to symbols with "@"', () => {
    expect(paletteInput('files', 'app.ts')).toEqual({ mode: 'files', query: 'app.ts' });
    expect(paletteInput('files', '>theme')).toEqual({ mode: 'commands', query: 'theme' });
    expect(paletteInput('files', '> theme')).toEqual({ mode: 'commands', query: 'theme' });
    expect(paletteInput('files', '@useNav')).toEqual({ mode: 'symbols', query: 'useNav' });
    expect(paletteInput('commands', '@x')).toEqual({ mode: 'commands', query: '@x' });
    expect(paletteInput('symbols', '>x')).toEqual({ mode: 'symbols', query: '>x' });
  });

  it('reads a line after the name of a file', () => {
    expect(fileQuery('src/app.ts:42')).toEqual({ text: 'src/app.ts', line: 42 });
    expect(fileQuery('app')).toEqual({ text: 'app', line: null });
    expect(fileQuery('app:')).toEqual({ text: 'app', line: null });
    expect(fileQuery('app:0')).toEqual({ text: 'app', line: null });
    expect(fileQuery('  app.ts:7 ')).toEqual({ text: 'app.ts', line: 7 });
  });

  it('shows a file by its name, with its folder beside it', () => {
    expect(fileRow('src/features/app.ts')).toEqual({ name: 'app.ts', folder: 'src/features' });
    expect(fileRow('README.md')).toEqual({ name: 'README.md', folder: '' });
  });

  it('lists files for what is typed now, never an older query’s as they were', () => {
    const everything = { text: '', paths: ['notes.txt', 'src/app.ts', 'src/greet.ts'] };
    // "greet" is typed and its answer is still on its way: the last answer, narrowed, so Enter opens greet.ts.
    expect(filesShown('greet', everything, [])).toEqual({ paths: ['src/greet.ts'], fresh: false });
    expect(filesShown('greet', { text: 'greet', paths: ['src/greet.ts'] }, [])).toEqual({ paths: ['src/greet.ts'], fresh: true });
    expect(filesShown('zzz', everything, [])).toEqual({ paths: [], fresh: false });
    expect(filesShown('anything', null, [])).toEqual({ paths: [], fresh: false });
    // With nothing typed, the files open in the Files panel come first, once each.
    expect(filesShown('', everything, ['src/greet.ts']).paths).toEqual(['src/greet.ts', 'notes.txt', 'src/app.ts']);
  });

  it('names a project for a symbol search by a file of it', () => {
    expect(anchorFile('src/y.tsx', ['a.css', 'src/x.ts'])).toBe('src/y.tsx');
    expect(anchorFile('README.md', ['a.css', 'node_modules/p/i.js', 'src/x.mts'])).toBe('src/x.mts');
    expect(anchorFile(null, ['a.css'])).toBeNull();
  });

  it('says why there is nothing to show', () => {
    expect(symbolMessage('untrusted', '')).toBe('Go to symbol needs a trusted project.');
    expect(symbolMessage('no-files', '')).toBe('No TypeScript or JavaScript files here.');
    expect(symbolMessage('searching', 'x')).toBe('Searching…');
    expect(symbolMessage('none', 'useNav')).toBe('No symbol matches "useNav".');
  });

  it('names kinds in words', () => {
    expect([symbolKind(5), symbolKind(11), symbolKind(12), symbolKind(13), symbolKind(999), symbolKind(0)]).toEqual(['class', 'interface', 'function', 'variable', 'symbol', 'symbol']);
  });

  it('shows only the answer to what was asked last', async () => {
    const shown = vi.fn();
    const show = latestOnly<string>(shown);
    let first: (value: string) => void = () => undefined;
    show(new Promise((resolve) => (first = resolve)));
    show(Promise.resolve('second'));
    await Promise.resolve();
    first('first');
    await Promise.resolve();
    await Promise.resolve();
    expect(shown.mock.calls).toEqual([['second']]);
  });

  it('tells of a failure only when it is the answer to what was asked last', async () => {
    const shown = vi.fn();
    const failed = vi.fn();
    const show = latestOnly<string>(shown, failed);
    show(Promise.reject(new Error('old')));
    show(Promise.reject(new Error('new')));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shown).not.toHaveBeenCalled();
    expect(failed.mock.calls.map(([error]) => (error as Error).message)).toEqual(['new']);
  });
});
