import { diffLines } from 'diff';

/** A change from one text to another: the characters `start` to `end` of the first become `text`. */
export interface TextChange {
  start: number;
  end: number;
  text: string;
}

/**
 * The changes that turn `before` into `after`, one per run of changed lines, in order. Made as editor edits they
 * leave a cursor or selection outside them where it was. Texts too different to compare within a moment become a
 * single change of everything between what they share at the start and at the end.
 */
export function textChanges(before: string, after: string): TextChange[] {
  if (before === after) return [];
  const parts = diffLines(before, after, { timeout: 200 });
  if (!parts) {
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let tail = 0;
    while (tail < before.length - start && tail < after.length - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
    return [{ start, end: before.length - tail, text: after.slice(start, after.length - tail) }];
  }
  const changes: TextChange[] = [];
  let at = 0;
  let open: TextChange | null = null;
  for (const part of parts) {
    if (!part.added && !part.removed) {
      if (open) changes.push(open);
      open = null;
      at += part.value.length;
      continue;
    }
    open ??= { start: at, end: at, text: '' };
    if (part.removed) {
      open.end += part.value.length;
      at += part.value.length;
    } else open.text += part.value;
  }
  if (open) changes.push(open);
  return changes;
}
