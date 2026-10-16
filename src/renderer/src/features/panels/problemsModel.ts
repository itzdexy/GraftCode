/** The problems in the changed files, as the Problems tab says them (pure; unit-tested). */

import type { ChangedProblems } from '@shared/schemas/semantic';

/** A request to fix problems lists this many; the rest are counted. */
const MAX_LISTED = 30;
/** No more changed files than this are checked (changedProblems.ts in the main process). */
const MAX_CHECKED = 50;

export function problemCount(result: ChangedProblems | null): number {
  return result === null ? 0 : result.files.reduce((count, file) => count + file.problems.length, 0);
}

/** The tab's name: with the count once a check has found any. */
export function problemsTab(count: number): string {
  return count > 0 ? `Problems (${String(count)})` : 'Problems';
}

/** What shows while a check runs; `files` is how many changed files it looks at, when that is known. */
export function checkingLabel(files: number | null): string {
  if (files === null) return 'Checking…';
  const checked = Math.min(files, MAX_CHECKED);
  return `Checking ${String(checked)} ${checked === 1 ? 'file' : 'files'}…`;
}

/**
 * The sentence for a result with nothing to list; null when there are
 * problems. A check that could not be made never reads as "No problems".
 */
export function problemsMessage(result: ChangedProblems): string | null {
  if (result.state === 'untrusted') return 'Problems need a trusted project.';
  if (result.state === 'no-packages') return "Install the project's packages to check it.";
  if (result.state === 'none') return 'No changed TypeScript or JavaScript files.';
  if (problemCount(result) > 0) return null;
  if (result.checked === 0) return 'None of the changed files could be checked.';
  return `No problems in the ${String(result.checked)} changed ${result.checked === 1 ? 'file' : 'files'} that could be checked.`;
}

/** The message that asks for the problems to be fixed. It is put in the message box; the user sends it. */
export function fixRequest(files: ChangedProblems['files']): string {
  const lines = files.flatMap((file) => file.problems.map((problem) => `- ${file.path}:${String(problem.line)}:${String(problem.column)} ${problem.text}${problem.code === null ? '' : ` (${String(problem.code)})`}`));
  const more = lines.length - MAX_LISTED;
  return ['Fix these problems:', ...lines.slice(0, MAX_LISTED), ...(more > 0 ? [`…and ${String(more)} more.`] : [])].join('\n');
}

/** What is in the message box, a blank line, then the request; the request alone for an empty box. */
export function withRequest(draft: string, request: string): string {
  const typed = draft.trimEnd();
  return typed.length === 0 ? request : `${typed}\n\n${request}`;
}
