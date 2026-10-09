import { CornerDownLeft, Pencil, X } from 'lucide-react';
import type { QueuedInput } from '@shared/schemas/sessions';
import { IconButton } from '../../components/Button';
import { cn } from '../../lib/cn';
import { invoke } from '../../lib/ipc';
import { reportError } from '../../stores/toasts';
import { useUi } from '../../stores/ui';

/** Puts a queued message back in the message box for editing (after anything already typed there). */
function editQueued(sessionId: string, item: QueuedInput): void {
  invoke('sessions:removeQueued', { id: sessionId, queueId: item.id })
    .then(() => {
      const draft = useUi.getState().drafts[sessionId] ?? '';
      useUi.getState().setDraft(sessionId, draft.trim().length > 0 ? `${draft.trimEnd()}\n${item.text}` : item.text);
      useUi.getState().focusComposer?.();
    })
    .catch((e: unknown) => reportError("Couldn't edit the message", e));
}

/**
 * Messages typed while Graft works. Each waits for the turn to end, unless
 * "Send now" hands it to the agent after its current step; it can also go
 * back to the message box for editing, or be removed.
 */
export function QueueBar({ sessionId, queue }: { sessionId: string; queue: QueuedInput[] }) {
  if (queue.length === 0) return null;
  const single = queue.length === 1;
  return (
    <ul aria-label="Queued messages" className="motion-rise flex flex-col gap-2 rounded-lg border border-border bg-raised p-3">
      {queue.map((q) => {
        const command = q.text.startsWith('/');
        return (
          <li key={q.id} data-steer={q.steer} className="graft-queue-item flex min-h-30 items-center gap-8 rounded-md pr-2 pl-9 text-base">
            <span className={cn('shrink-0 font-medium', q.steer ? 'text-accent' : 'text-fg')}>
              {q.steer ? 'Next step' : single ? '1 message queued' : 'Queued'}
            </span>
            <span className="min-w-0 flex-1 truncate text-fg-muted" title={q.text}>
              {q.text}
              {q.attachmentCount > 0 ? ` (+${String(q.attachmentCount)} attachment${q.attachmentCount === 1 ? '' : 's'})` : ''}
            </span>
            {q.steer || command ? null : (
              <IconButton
                label="Send now: Graft reads it after its current step"
                size="xs"
                onClick={() => invoke('sessions:steer', { id: sessionId, queueId: q.id }).catch((e: unknown) => reportError("Couldn't send it now", e))}
              >
                <CornerDownLeft className="size-14" />
              </IconButton>
            )}
            <IconButton
              label={q.attachmentCount > 0 ? 'Messages with attachments can’t be edited; remove it and send it again' : 'Edit'}
              size="xs"
              disabled={q.attachmentCount > 0}
              onClick={() => editQueued(sessionId, q)}
            >
              <Pencil className="size-14" />
            </IconButton>
            <IconButton
              label="Remove"
              size="xs"
              onClick={() => invoke('sessions:removeQueued', { id: sessionId, queueId: q.id }).catch((e: unknown) => reportError("Couldn't remove it", e))}
            >
              <X className="size-14" />
            </IconButton>
          </li>
        );
      })}
    </ul>
  );
}
