/** The problems in the changed files, as the Problems tab says them (pure; unit-tested). */

import type { ChangedProblems } from '@shared/schemas/semantic';
import { problemLine } from '@shared/problems';

export { problemCount, problemsMessage } from '@shared/problems';

/** A request to fix problems lists this many; the rest are counted. */
const MAX_LISTED = 30;
/** No more changed files than this are checked (changedProblems.ts in the main process). */
const MAX_CHECKED = 50;

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

/** The message that asks for the problems to be fixed. It is put in the message box; the user sends it. */
export function fixRequest(files: ChangedProblems['files']): string {
  const lines = files.flatMap((file) => file.problems.map((problem) => `- ${problemLine(file.path, problem)}`));
  const more = lines.length - MAX_LISTED;
  return ['Fix these problems:', ...lines.slice(0, MAX_LISTED), ...(more > 0 ? [`…and ${String(more)} more.`] : [])].join('\n');
}

/** What is in the message box, a blank line, then the request; the request alone for an empty box. */
export function withRequest(draft: string, request: string): string {
  const typed = draft.trimEnd();
  return typed.length === 0 ? request : `${typed}\n\n${request}`;
}
