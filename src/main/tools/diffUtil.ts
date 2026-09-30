import { createTwoFilesPatch } from 'diff';

const MAX_DIFF_INPUT = 1_000_000;

export interface PatchInfo {
  patch: string;
  added: number;
  removed: number;
}

/** Unified diff between two versions of a file, with line counts. */
export function unifiedDiff(name: string, before: string, after: string): PatchInfo {
  if (before.length > MAX_DIFF_INPUT || after.length > MAX_DIFF_INPUT) {
    return { patch: `(diff omitted: ${name} is too large to diff)`, added: 0, removed: 0 };
  }
  const a = before.replace(/\r\n/g, '\n');
  const b = after.replace(/\r\n/g, '\n');
  const patch = createTwoFilesPatch(`a/${name}`, `b/${name}`, a, b, '', '', { context: 3 });
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  // Drop the "Index:" / "====" preamble that createTwoFilesPatch emits.
  const body = patch.replace(/^Index:.*\n=+\n/, '');
  return { patch: body, added, removed };
}
