import path from 'node:path';
import type { SemanticResult } from './types';

/**
 * The errors the language server finds in a file right after an edit, and
 * how they are told to the model with the edit's result: a type error is then
 * fixed in the next step instead of surfacing in a build later.
 */

/** One error at a place in a file (line and column count from 1). */
export interface Problem {
  line: number;
  column: number;
  /** The checker's own name for this kind of error, e.g. 2322; null when it gave none. */
  code: string | number | null;
  text: string;
}

/** The problems of one file: the first few, and how many there are in all. */
export interface FileProblems {
  /** Who reports them, e.g. "TypeScript". */
  source: string;
  problems: Problem[];
  total: number;
}

/** How many problems are told to the model and shown; the rest are counted. */
export const MAX_PROBLEMS = 10;
const MAX_TEXT = 300;
/** An edit waits this long for the server (it may be starting, or loading a large project); after that the edit goes on unchecked. */
export const CHECK_BUDGET_MS = 10_000;
/** The server's severity for an error; warnings and suggestions are not what breaks a build. */
const ERROR = 1;

/** TypeScript and JavaScript sources, module flavours included: what the server checks. */
export function isCheckable(file: string): boolean {
  return /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file);
}

/** The errors among a server's diagnostics, in the order of the file, each on one line. */
export function toProblems(diagnostics: NonNullable<SemanticResult['diagnostics']>): Problem[] {
  return diagnostics
    .filter((d) => d.severity === ERROR)
    .map((d) => ({
      line: d.line,
      column: d.column,
      code: d.code,
      // A message can run over several lines, each explaining the one before; one line carries them all.
      text: d.message.split(/\s*\n\s*/).join(' ').trim().slice(0, MAX_TEXT)
    }))
    .sort((a, b) => a.line - b.line || a.column - b.column);
}

/** The note added to an edit's result when the file now has problems. */
export function problemsNote(shown: string, found: FileProblems): string {
  const lines = found.problems.slice(0, MAX_PROBLEMS).map((p) => {
    const code = typeof p.code === 'number' ? `TS${String(p.code)}` : p.code;
    return `  ${String(p.line)}:${String(p.column)}  ${code ? `${code}  ` : ''}${p.text}`;
  });
  const more = found.total - lines.length;
  return [
    `${found.source} reports ${String(found.total)} ${found.total === 1 ? 'problem' : 'problems'} in ${shown} as it is now:`,
    ...lines,
    ...(more > 0 ? [`  …and ${String(more)} more.`] : []),
    'Fix what this change caused. Problems that were there before can wait unless they are in your way.'
  ].join('\n');
}

/** What is asked of the language servers here: one query. */
export interface DiagnosticsSource {
  query(root: string, input: { action: 'diagnostics'; file: string }, signal: AbortSignal): Promise<SemanticResult>;
}

/**
 * The errors in `file` (inside the project at `root`) as it is on disk now.
 * Null when nothing can say: not a file the server checks, outside the
 * project, the server gave no current answer, or the wait ran out. Null is
 * never "no problems": a file found clean comes back with an empty list.
 */
export async function problemsIn(servers: DiagnosticsSource, root: string, file: string, signal: AbortSignal, budgetMs = CHECK_BUDGET_MS): Promise<FileProblems | null> {
  if (!isCheckable(file)) return null;
  const relative = path.relative(root, file);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  try {
    const result = await servers.query(root, { action: 'diagnostics', file: relative.replaceAll(path.sep, '/') }, AbortSignal.any([signal, AbortSignal.timeout(budgetMs)]));
    if (!result.diagnostics) return null;
    const errors = toProblems(result.diagnostics);
    return { source: 'TypeScript', problems: errors.slice(0, MAX_PROBLEMS), total: errors.length };
  } catch {
    // A server that is busy, slow or gone never fails the edit that asked.
    return null;
  }
}
