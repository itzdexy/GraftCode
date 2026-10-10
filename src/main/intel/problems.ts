/**
 * What a language server found wrong with a file, and how that is told to
 * the model after an edit. Pure, so it is unit-tested without a server.
 */

/** One error at a place in a file (line and column count from 1). */
export interface Problem {
  line: number;
  column: number;
  /** The checker's number for this kind of error, e.g. 2322. */
  code: number;
  text: string;
}

/** The problems of one file: the first few, and how many there are in all. */
export interface FileProblems {
  /** Who reports them, e.g. "TypeScript". */
  source: string;
  problems: Problem[];
  total: number;
}

/** How many problems are told to the model; the rest are counted. */
export const MAX_PROBLEMS = 10;
const MAX_TEXT = 300;

/** A diagnostic as a TypeScript server sends it, as far as it is read here. */
interface Diagnostic {
  start?: { line?: number; offset?: number };
  text?: string;
  code?: number;
  category?: string;
}

/** The errors among a server's diagnostics, in the order of the file. Warnings and suggestions are left out: they are not what breaks a build. */
export function toProblems(diagnostics: unknown): Problem[] {
  if (!Array.isArray(diagnostics)) return [];
  return (diagnostics as Diagnostic[])
    .filter((d) => d !== null && typeof d === 'object' && d.category === 'error')
    .map((d) => ({
      line: d.start?.line ?? 1,
      column: d.start?.offset ?? 1,
      code: d.code ?? 0,
      // A message can run over several lines, each explaining the one before; one line carries them all.
      text: (d.text ?? '').split(/\s*\n\s*/).join(' ').trim().slice(0, MAX_TEXT)
    }))
    .sort((a, b) => a.line - b.line || a.column - b.column);
}

/** The note added to an edit's result when the file now has problems. */
export function problemsNote(shown: string, found: FileProblems): string {
  const lines = found.problems.slice(0, MAX_PROBLEMS).map((p) => `  ${String(p.line)}:${String(p.column)}  TS${String(p.code)}  ${p.text}`);
  const more = found.total - lines.length;
  return [
    `${found.source} reports ${String(found.total)} ${found.total === 1 ? 'problem' : 'problems'} in ${shown} as it is now:`,
    ...lines,
    ...(more > 0 ? [`  …and ${String(more)} more.`] : []),
    'Fix what this change caused. Problems that were there before can wait unless they are in your way.'
  ].join('\n');
}
