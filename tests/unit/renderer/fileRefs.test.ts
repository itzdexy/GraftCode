import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseFileRef, refTooltip } from '../../../src/renderer/src/features/session/fileRefs';
import { createRefBatcher, useFileRefs } from '../../../src/renderer/src/stores/fileRefs';

// The store asks through lib/ipc, which needs the app's window; this file never lets it ask.
vi.mock('../../../src/renderer/src/lib/ipc', async (original) => ({ ...(await original<object>()), invoke: vi.fn() }));

afterEach(() => vi.useRealTimers());
const ref = (path: string, line: number | null = null, endLine: number | null = null, column: number | null = null) => ({ path, line, endLine, column });

describe('a file named in a reply', () => {
  it('is read with its line, lines or column', () => {
    expect(parseFileRef('src/health.js')).toEqual(ref('src/health.js'));
    expect(parseFileRef('src/health.js:14')).toEqual(ref('src/health.js', 14));
    expect(parseFileRef('src/health.js:14-20')).toEqual(ref('src/health.js', 14, 20));
    expect(parseFileRef('src/health.js:14:7')).toEqual(ref('src/health.js', 14, null, 7));
    expect(parseFileRef('src/health.js#L14')).toEqual(ref('src/health.js', 14));
    expect(parseFileRef('./health.test.js')).toEqual(ref('health.test.js'));
    expect(parseFileRef('src\\win\\a.ts:3')).toEqual(ref('src/win/a.ts', 3));
    expect(parseFileRef('C:\\proj\\a.ts:3')).toEqual(ref('C:/proj/a.ts', 3));
    expect(parseFileRef('Dockerfile')).toEqual(ref('Dockerfile'));
    expect(parseFileRef('docker/Makefile:9')).toEqual(ref('docker/Makefile', 9));
    expect(parseFileRef('.env')).toEqual(ref('.env'));
    expect(parseFileRef('a.ts:20-5')).toEqual(ref('a.ts', 20));
    expect(parseFileRef('  src/app.tsx  ')).toEqual(ref('src/app.tsx'));
  });

  it('is not seen in other code', () => {
    for (const text of ['health()', 'src/health.js()', '0.6.18', '1.2', 'npm', 'node_modules', 'e.g.', 'https://x.dev/a.js', 'a b.ts', '', 'a.ts:0', 'a.toolongextension', `${'x'.repeat(260)}.ts`, './', '.', 'a.ts:', 'a.ts#L0']) {
      expect(parseFileRef(text), text).toBeNull();
    }
  });

  it('says what a click does', () => {
    expect(refTooltip('src/a.ts', null)).toBe('Open src/a.ts');
    expect(refTooltip('src/a.ts', 14)).toBe('Open src/a.ts at line 14');
  });
});

describe('asking which names are files', () => {
  it('asks in batches of 200 after 50 ms, and once for a name asked twice', async () => {
    vi.useFakeTimers();
    const asked: string[][] = [];
    const answers: Array<[string, string | null]> = [];
    const batcher = createRefBatcher(
      (_session, paths) => {
        asked.push(paths);
        return Promise.resolve(paths.map((p) => (p === 'f7.ts' ? null : `src/${p}`)));
      },
      (_session, path, resolved) => answers.push([path, resolved])
    );
    for (let i = 0; i < 450; i++) batcher.ask('s', `f${String(i)}.ts`);
    batcher.ask('s', 'f1.ts');
    expect(asked).toEqual([]);
    await vi.advanceTimersByTimeAsync(50);
    expect(asked.map((batch) => batch.length)).toEqual([200, 200, 50]);
    expect(answers).toHaveLength(450);
    expect(answers.find(([p]) => p === 'f7.ts')).toEqual(['f7.ts', null]);
    expect(answers.find(([p]) => p === 'f8.ts')).toEqual(['f8.ts', 'src/f8.ts']);
  });

  it('keeps the names of two sessions apart', async () => {
    vi.useFakeTimers();
    const asked: Array<[string, string[]]> = [];
    const batcher = createRefBatcher(
      (session, paths) => {
        asked.push([session, paths]);
        return Promise.resolve(paths.map(() => null));
      },
      () => undefined
    );
    batcher.ask('one', 'a.ts');
    batcher.ask('two', 'a.ts');
    batcher.ask('one', 'b.ts');
    await vi.advanceTimersByTimeAsync(50);
    expect(asked).toEqual([['one', ['a.ts', 'b.ts']], ['two', ['a.ts']]]);
  });

  it('answers "no file" for a batch that fails, so nothing waits for ever', async () => {
    vi.useFakeTimers();
    const answers: Array<[string, string | null]> = [];
    const batcher = createRefBatcher(() => Promise.reject(new Error('gone')), (_s, path, resolved) => answers.push([path, resolved]));
    batcher.ask('s', 'a.ts');
    await vi.advanceTimersByTimeAsync(50);
    expect(answers).toEqual([['a.ts', null]]);
  });

  it('answers "no file" for names an answer left out', async () => {
    vi.useFakeTimers();
    const answers: Array<[string, string | null]> = [];
    const batcher = createRefBatcher(() => Promise.resolve(['src/a.ts']), (_s, path, resolved) => answers.push([path, resolved]));
    batcher.ask('s', 'a.ts');
    batcher.ask('s', 'b.ts');
    await vi.advanceTimersByTimeAsync(50);
    expect(answers).toEqual([['a.ts', 'src/a.ts'], ['b.ts', null]]);
  });

  it('forgets what it learned about a session, so a file made since is found', () => {
    useFileRefs.setState({ known: { s: { 'new.ts': null }, other: { 'a.ts': 'src/a.ts' } } });
    useFileRefs.getState().forget('s');
    expect(useFileRefs.getState().known).toEqual({ other: { 'a.ts': 'src/a.ts' } });
  });
});
