/** The problems in a session's changed files, in words: the Problems tab says them so, and "@problems" sends them so (pure; unit-tested). */

import type { ChangedProblems } from './schemas/semantic';

export function problemCount(result: ChangedProblems | null): number {
  return result === null ? 0 : result.files.reduce((count, file) => count + file.problems.length, 0);
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

/** One problem on one line: where it is, what is wrong, and the checker's code for it. */
export function problemLine(path: string, problem: ChangedProblems['files'][number]['problems'][number]): string {
  return `${path}:${String(problem.line)}:${String(problem.column)} ${problem.text}${problem.code === null ? '' : ` (${String(problem.code)})`}`;
}
