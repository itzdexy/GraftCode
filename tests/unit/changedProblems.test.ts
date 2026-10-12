import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { changedProblems } from '../../src/main/languages/changedProblems';
import type { DiagnosticsSource } from '../../src/main/languages/problems';
import type { SemanticResult } from '../../src/shared/schemas/semantic';

const ROOT = path.resolve('/project');
const answer = (file: string, diagnostics: Array<[number, number, number, string]>): SemanticResult => ({
  engine: 'typescript-language-server',
  file,
  action: 'diagnostics',
  truncated: false,
  diagnostics: diagnostics.map(([line, column, severity, message]) => ({ file, line, column, severity, code: 2322, message }))
});
const source = (answers: Record<string, () => Promise<SemanticResult>>): DiagnosticsSource => ({ query: (_root, input) => (answers[input.file] ?? (() => Promise.reject(new Error(`no answer for ${input.file}`))))() });
const never = (): Promise<SemanticResult> => new Promise(() => undefined);
const ask = (changed: string[], answers: Record<string, () => Promise<SemanticResult>>, over: Partial<Parameters<typeof changedProblems>[0]> = {}) =>
  changedProblems({ root: ROOT, trusted: true, changed, source: source(answers), missing: () => false, fileBudgetMs: 30, totalBudgetMs: 200, ...over });

describe('the problems in what changed', () => {
  it('lists errors and warnings of the changed TypeScript and JavaScript files, in order', async () => {
    const result = await ask(['src/a.ts', 'README.md', 'src/b.js'], {
      'src/a.ts': () => Promise.resolve(answer('src/a.ts', [[12, 5, 1, "Type 'string' is not\n  assignable to type 'number'."], [3, 1, 2, 'Unused.'], [9, 9, 4, 'A hint.']])),
      'src/b.js': () => Promise.resolve(answer('src/b.js', []))
    });
    expect(result).toEqual({
      state: 'ok',
      checked: 2,
      unchecked: [],
      files: [{ path: 'src/a.ts', problems: [{ line: 3, column: 1, severity: 'warning', code: 2322, text: 'Unused.' }, { line: 12, column: 5, severity: 'error', code: 2322, text: "Type 'string' is not assignable to type 'number'." }] }]
    });
  });

  it('says which files it could not check, and why', async () => {
    const result = await ask(['slow.ts', 'broken.ts'], { 'slow.ts': never, 'broken.ts': () => Promise.reject(new Error('The server stopped.')) });
    expect(result.state).toBe('ok');
    expect(result.checked).toBe(0);
    expect(result.files).toEqual([]);
    expect(result.unchecked).toEqual([{ path: 'slow.ts', reason: 'Took longer than 5 seconds.' }, { path: 'broken.ts', reason: 'The server stopped.' }]);
    // The whole check has a limit too: a file whose turn comes after it is not asked.
    const late = await ask(['slow.ts', 'late.ts'], { 'slow.ts': never, 'late.ts': never }, { totalBudgetMs: 10 });
    expect(late.unchecked).toEqual([{ path: 'slow.ts', reason: 'Took longer than 5 seconds.' }, { path: 'late.ts', reason: 'Not reached in 60 seconds.' }]);
  });

  it('calls off a question that ran out of time, and takes an answer without diagnostics for a failure', async () => {
    let stopped = false;
    const waiting: DiagnosticsSource = {
      query: (_root, _input, signal) =>
        new Promise(() => {
          signal.addEventListener('abort', () => (stopped = true));
        })
    };
    await changedProblems({ root: ROOT, trusted: true, changed: ['a.ts'], source: waiting, missing: () => false, fileBudgetMs: 10, totalBudgetMs: 200 });
    expect(stopped).toBe(true);
    const silent = await ask(['a.ts'], { 'a.ts': () => Promise.resolve({ engine: 'typescript-language-server', file: 'a.ts', action: 'diagnostics', truncated: false }) });
    expect(silent).toMatchObject({ checked: 0, unchecked: [{ path: 'a.ts', reason: 'The server did not return diagnostics.' }] });
  });

  it('checks nothing in an untrusted project, without packages, or with nothing to check', async () => {
    let asked = 0;
    const counting: Record<string, () => Promise<SemanticResult>> = {
      'a.ts': () => {
        asked++;
        return Promise.resolve(answer('a.ts', []));
      }
    };
    expect((await ask(['a.ts'], counting, { trusted: false })).state).toBe('untrusted');
    expect((await ask(['a.ts'], counting, { missing: () => true })).state).toBe('no-packages');
    expect(await ask(['README.md', 'a.css'], counting)).toEqual({ state: 'none', checked: 0, files: [], unchecked: [] });
    expect(asked).toBe(0);
  });

  it('asks about the files whose packages are there when only some are missing theirs', async () => {
    const result = await ask(['app/a.ts', 'lib/b.ts'], { 'lib/b.ts': () => Promise.resolve(answer('lib/b.ts', [])) }, { missing: (_root, file) => file.includes(`${path.sep}app${path.sep}`) });
    expect(result).toEqual({ state: 'ok', checked: 1, files: [], unchecked: [{ path: 'app/a.ts', reason: 'Its packages are not installed.' }] });
  });

  it('checks 50 files at most', async () => {
    const changed = Array.from({ length: 60 }, (_, i) => `f${String(i)}.ts`);
    const result = await ask(changed, Object.fromEntries(changed.map((f) => [f, () => Promise.resolve(answer(f, []))])));
    expect(result.checked).toBe(50);
    expect(result.unchecked).toHaveLength(10);
    expect(result.unchecked[0]).toEqual({ path: 'f50.ts', reason: 'Only the first 50 changed files are checked.' });
  });
});
