import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isCheckable, MAX_PROBLEMS, problemsIn, problemsNote, toProblems, type DiagnosticsSource, type FileProblems } from '../../src/main/languages/problems';
import type { SemanticResult } from '../../src/main/languages/types';

type Diagnostic = NonNullable<SemanticResult['diagnostics']>[number];

const diagnostic = (line: number, column: number, severity: number, code: number | string | null, message: string): Diagnostic => ({ file: 'src/a.ts', line, column, severity, code, message });

const DIAGNOSTICS: Diagnostic[] = [
  diagnostic(30, 1, 1, 2304, "Cannot find name 'foo'."),
  diagnostic(12, 5, 1, 2322, "Type 'string' is not assignable to type 'number'.\n  The expected type comes from property 'n'."),
  diagnostic(3, 1, 4, 6133, "'x' is declared but never used."),
  diagnostic(4, 1, 2, 7027, 'Unreachable code detected.')
];

/** Language servers that answer every query with these diagnostics, and remember what they were asked. */
function servers(answer: (file: string, signal: AbortSignal) => Promise<SemanticResult>): DiagnosticsSource & { asked: Array<{ root: string; file: string }> } {
  const asked: Array<{ root: string; file: string }> = [];
  return {
    asked,
    query: (root, input, signal) => {
      asked.push({ root, file: input.file });
      return answer(input.file, signal);
    }
  };
}

const result = (file: string, diagnostics: Diagnostic[] | undefined): SemanticResult => ({ engine: 'typescript-language-server', file, action: 'diagnostics', truncated: false, ...(diagnostics ? { diagnostics } : {}) });

describe('problems in a file after an edit', () => {
  const root = path.resolve('project');
  const file = path.join(root, 'src', 'a.ts');
  const signal = new AbortController().signal;

  it('are the errors, in the order of the file, each on one line', () => {
    expect(toProblems(DIAGNOSTICS)).toEqual([
      { line: 12, column: 5, code: 2322, text: "Type 'string' is not assignable to type 'number'. The expected type comes from property 'n'." },
      { line: 30, column: 1, code: 2304, text: "Cannot find name 'foo'." }
    ]);
    expect(toProblems([])).toEqual([]);
  });

  it('are told to the model with where each one is, and how many were left out', () => {
    const found: FileProblems = { source: 'TypeScript', problems: toProblems(DIAGNOSTICS), total: 2 };
    expect(problemsNote('src/a.ts', found)).toBe(
      [
        'TypeScript reports 2 problems in src/a.ts as it is now:',
        "  12:5  TS2322  Type 'string' is not assignable to type 'number'. The expected type comes from property 'n'.",
        "  30:1  TS2304  Cannot find name 'foo'.",
        'Fix what this change caused. Problems that were there before can wait unless they are in your way.'
      ].join('\n')
    );
    expect(problemsNote('a.ts', { source: 'TypeScript', problems: found.problems.slice(0, 1), total: 14 })).toContain('…and 13 more.');
    expect(problemsNote('a.ts', { source: 'TypeScript', problems: found.problems.slice(0, 1), total: 1 })).toContain('reports 1 problem in a.ts');
    // A problem the checker gave no number keeps its place and its text.
    expect(problemsNote('a.ts', { source: 'TypeScript', problems: [{ line: 1, column: 2, code: null, text: 'Odd.' }], total: 1 })).toContain('  1:2  Odd.');
  });

  it('asks the server about the file by its path inside the project', async () => {
    const lsp = servers((asked) => Promise.resolve(result(asked, DIAGNOSTICS)));
    expect(await problemsIn(lsp, root, file, signal)).toEqual({ source: 'TypeScript', problems: toProblems(DIAGNOSTICS), total: 2 });
    expect(lsp.asked).toEqual([{ root, file: 'src/a.ts' }]);
  });

  it('counts every error but passes on only the first few', async () => {
    const many = Array.from({ length: MAX_PROBLEMS + 7 }, (_, i) => diagnostic(i + 1, 1, 1, 2304, `Cannot find name 'n${String(i)}'.`));
    const found = await problemsIn(servers((asked) => Promise.resolve(result(asked, many))), root, file, signal);
    expect(found?.total).toBe(MAX_PROBLEMS + 7);
    expect(found?.problems).toHaveLength(MAX_PROBLEMS);
  });

  it('finds a clean file clean, which is not the same as having no answer', async () => {
    expect(await problemsIn(servers((asked) => Promise.resolve(result(asked, [diagnostic(1, 1, 4, 6133, 'unused')]))), root, file, signal)).toEqual({ source: 'TypeScript', problems: [], total: 0 });
    // An answer without diagnostics, a refusal and a server that is gone all mean "nobody can say".
    expect(await problemsIn(servers((asked) => Promise.resolve(result(asked, undefined))), root, file, signal)).toBeNull();
    expect(await problemsIn(servers(() => Promise.reject(new Error('Language server exited.'))), root, file, signal)).toBeNull();
  });

  it('never asks about a file the server does not check, or one outside the project', async () => {
    const lsp = servers((asked) => Promise.resolve(result(asked, DIAGNOSTICS)));
    expect(await problemsIn(lsp, root, path.join(root, 'README.md'), signal)).toBeNull();
    expect(await problemsIn(lsp, root, path.resolve('elsewhere', 'a.ts'), signal)).toBeNull();
    expect(await problemsIn(lsp, root, root, signal)).toBeNull();
    expect(lsp.asked).toEqual([]);
    for (const name of ['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'A.TS']) expect(isCheckable(name), name).toBe(true);
    for (const name of ['a.json', 'a.css', 'a.md', 'ts', 'a.tsbuildinfo', 'a.ts.map']) expect(isCheckable(name), name).toBe(false);
  });

  it('stops waiting when the server takes too long, and lets the edit go on unchecked', async () => {
    let cancelled = false;
    const slow = servers(
      (_asked, waiting) =>
        new Promise<SemanticResult>((_resolve, reject) => {
          waiting.addEventListener('abort', () => {
            cancelled = true;
            reject(new Error('Semantic query cancelled.'));
          });
        })
    );
    expect(await problemsIn(slow, root, file, signal, 30)).toBeNull();
    // The query is told to stop, so a slow server is not left working for nobody.
    expect(cancelled).toBe(true);
  });
});
