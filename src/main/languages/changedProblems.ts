import path from 'node:path';
import type { ChangedProblems } from '@shared/schemas/semantic';
import { isCheckable, packagesMissing, type DiagnosticsSource } from './problems';

/**
 * The errors and warnings the language server reports for the files a session
 * has changed, in one list. A check that could not be made is never passed
 * off as a clean one: every file is either checked or named with the reason.
 */

/** More changed files than this are not checked; the rest are named as such. */
export const MAX_CHANGED_FILES = 50;
/** One file waits this long for the server… */
export const FILE_BUDGET_MS = 5_000;
/** …and the whole check ends here, however many files are left. */
export const TOTAL_BUDGET_MS = 60_000;
const MAX_TEXT = 300;
/** The server's severities that are listed; information and hints are not problems. */
const SEVERITY: Record<number, 'error' | 'warning'> = { 1: 'error', 2: 'warning' };

type Checked = ChangedProblems['files'][number]['problems'];

const TOO_SLOW = Symbol('too slow');

/** One file's problems, by line and column, each message on one line. */
function problemsOf(diagnostics: NonNullable<Awaited<ReturnType<DiagnosticsSource['query']>>['diagnostics']>): Checked {
  return diagnostics
    .flatMap((d) => {
      const severity = SEVERITY[d.severity];
      // A message can run over several lines, each explaining the one before; one line carries them all.
      return severity ? [{ line: d.line, column: d.column, severity, code: d.code, text: d.message.split(/\s*\n\s*/).join(' ').trim().slice(0, MAX_TEXT) }] : [];
    })
    .sort((a, b) => a.line - b.line || a.column - b.column);
}

/** The server's answer for one file, or TOO_SLOW once `ms` have passed; the question is called off then. */
async function askWithin(source: DiagnosticsSource, root: string, file: string, ms: number): Promise<Checked | typeof TOO_SLOW> {
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TOO_SLOW>((resolve) => {
    timer = setTimeout(() => {
      stop.abort();
      resolve(TOO_SLOW);
    }, ms);
  });
  try {
    return await Promise.race([
      source.query(root, { action: 'diagnostics', file }, stop.signal).then((result) => {
        if (!result.diagnostics) throw new Error('The server did not return diagnostics.');
        return problemsOf(result.diagnostics);
      }),
      late
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function changedProblems(input: {
  root: string;
  /** Language servers run only in a project the user trusts. */
  trusted: boolean;
  /** Paths from the root, with "/", of changed files that exist. */
  changed: string[];
  source: DiagnosticsSource;
  fileBudgetMs?: number;
  totalBudgetMs?: number;
  /** True when the packages a file would import are not installed (see packagesMissing). */
  missing?: (root: string, file: string) => boolean;
}): Promise<ChangedProblems> {
  const nothing = { checked: 0, files: [], unchecked: [] };
  if (!input.trusted) return { state: 'untrusted', ...nothing };
  const checkable = input.changed.filter(isCheckable);
  if (checkable.length === 0) return { state: 'none', ...nothing };
  // Without its packages every import of a file is an error, and none of them is what the change did.
  const missing = input.missing ?? packagesMissing;
  const without = new Set(checkable.filter((file) => missing(input.root, path.resolve(input.root, file))));
  if (without.size === checkable.length) return { state: 'no-packages', ...nothing };

  const fileBudget = input.fileBudgetMs ?? FILE_BUDGET_MS;
  const totalBudget = input.totalBudgetMs ?? TOTAL_BUDGET_MS;
  const started = Date.now();
  const files: ChangedProblems['files'] = [];
  const unchecked: ChangedProblems['unchecked'] = [];
  let checked = 0;
  // One after another: the server answers one question at a time anyway, and the first pays for its start.
  for (const file of checkable.slice(0, MAX_CHANGED_FILES)) {
    if (without.has(file)) {
      unchecked.push({ path: file, reason: 'Its packages are not installed.' });
      continue;
    }
    if (Date.now() - started >= totalBudget) {
      unchecked.push({ path: file, reason: 'Not reached in 60 seconds.' });
      continue;
    }
    try {
      const found = await askWithin(input.source, input.root, file, fileBudget);
      if (found === TOO_SLOW) {
        unchecked.push({ path: file, reason: 'Took longer than 5 seconds.' });
        continue;
      }
      checked++;
      if (found.length > 0) files.push({ path: file, problems: found });
    } catch (error) {
      unchecked.push({ path: file, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const file of checkable.slice(MAX_CHANGED_FILES)) unchecked.push({ path: file, reason: 'Only the first 50 changed files are checked.' });
  return { state: 'ok', checked, files, unchecked };
}
