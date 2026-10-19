import type { QueuedInput } from '@shared/schemas/sessions';

/** Up to this many queued messages are listed as they are; more fold into one line that opens. */
export const QUEUE_FOLD_AT = 2;

/** The folded line: how many wait, and the start of the one that goes next. */
export function queueHeadline(queue: QueuedInput[]): { count: string; next: string } | null {
  const first = queue[0];
  if (!first) return null;
  const extra = first.attachmentCount > 0 ? ` (+${String(first.attachmentCount)} attachment${first.attachmentCount === 1 ? '' : 's'})` : '';
  return {
    count: queue.length === 1 ? '1 message queued' : `${String(queue.length)} messages queued`,
    next: `${first.text.replace(/\s+/g, ' ').trim()}${extra}`
  };
}
