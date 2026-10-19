import { useState } from 'react';
import { ChevronDown, CornerDownLeft, Pencil, X } from 'lucide-react';
import type { QueuedInput } from '@shared/schemas/sessions';
import { Button, IconButton } from '../../components/Button';
import { Collapse } from '../../components/Collapse';
import { cn } from '../../lib/cn';
import { invoke } from '../../lib/ipc';
import { reportError } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { QUEUE_FOLD_AT, queueHeadline } from './queueModel';

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

function removeQueued(sessionId: string, item: QueuedInput): Promise<void> {
  return invoke('sessions:removeQueued', { id: sessionId, queueId: item.id }).then(
    () => undefined,
    (e: unknown) => reportError("Couldn't remove it", e)
  );
}

/** One queued message with what can be done with it: send it now, take it back to edit, or remove it. */
function QueueRow({ sessionId, item, label, clamp }: { sessionId: string; item: QueuedInput; label: string | null; clamp: boolean }) {
  const command = item.text.startsWith('/');
  return (
    <li data-steer={item.steer} className="graft-queue-item flex min-h-30 items-center gap-8 rounded-md pr-2 pl-9 text-base">
      {label ? <span className={cn('shrink-0 font-medium', item.steer ? 'text-accent' : 'text-fg')}>{label}</span> : null}
      <span className={cn('min-w-0 flex-1 text-fg-muted', clamp ? 'line-clamp-2 py-4 break-words' : 'truncate')} title={item.text}>
        {item.text}
        {item.attachmentCount > 0 ? ` (+${String(item.attachmentCount)} attachment${item.attachmentCount === 1 ? '' : 's'})` : ''}
      </span>
      {item.steer || command ? null : (
        <IconButton
          label="Send now: Graft reads it after its current step"
          size="xs"
          onClick={() => invoke('sessions:steer', { id: sessionId, queueId: item.id }).catch((e: unknown) => reportError("Couldn't send it now", e))}
        >
          <CornerDownLeft className="size-14" />
        </IconButton>
      )}
      <IconButton
        label={item.attachmentCount > 0 ? 'Messages with attachments can’t be edited; remove it and send it again' : 'Edit'}
        size="xs"
        disabled={item.attachmentCount > 0}
        onClick={() => editQueued(sessionId, item)}
      >
        <Pencil className="size-14" />
      </IconButton>
      <IconButton label="Remove" size="xs" onClick={() => void removeQueued(sessionId, item)}>
        <X className="size-14" />
      </IconButton>
    </li>
  );
}

/**
 * Messages typed while Graft works. Each waits for the turn to end, unless
 * "Send now" hands it to the agent after its current step; it can also go
 * back to the message box for editing, or be removed. Several fold into one
 * line, "N messages queued · Next: …", that opens to the whole list.
 */
export function QueueBar({ sessionId, queue }: { sessionId: string; queue: QueuedInput[] }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const headline = queueHeadline(queue);
  if (!headline) return null;

  if (queue.length < QUEUE_FOLD_AT) {
    const single = queue.length === 1;
    return (
      <ul aria-label="Queued messages" className="motion-rise flex flex-col gap-2 rounded-lg border border-border bg-raised p-3">
        {queue.map((q) => (
          <QueueRow key={q.id} sessionId={sessionId} item={q} label={q.steer ? 'Next step' : single ? '1 message queued' : 'Queued'} clamp={false} />
        ))}
      </ul>
    );
  }

  const clearAll = async (): Promise<void> => {
    setClearing(true);
    // One at a time, in order: each removal is its own request, and a failure stops there with what is left still queued.
    for (const item of queue) await removeQueued(sessionId, item);
    setClearing(false);
    setConfirming(false);
  };

  return (
    <section aria-label="Queued messages" className="motion-rise flex flex-col rounded-lg border border-border bg-raised">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setConfirming(false);
        }}
        className="flex min-h-34 items-center gap-8 rounded-lg px-12 text-left text-base transition-ui hover:bg-hover"
      >
        <span className="shrink-0 font-medium text-fg">{headline.count}</span>
        {open ? (
          <span className="flex-1" />
        ) : (
          <span className="min-w-0 flex-1 truncate text-fg-muted">
            <span className="text-fg-faint">Next: </span>
            {headline.next}
          </span>
        )}
        <ChevronDown className={cn('size-14 shrink-0 text-icon transition-transform duration-[var(--g-duration-fast)]', open && 'rotate-180')} aria-hidden="true" />
      </button>
      <Collapse open={open}>
        <ul className="flex flex-col gap-2 border-t border-border-subtle p-3">
          {queue.map((q, i) => (
            <QueueRow key={q.id} sessionId={sessionId} item={q} label={q.steer ? 'Next step' : i === 0 ? 'Next' : null} clamp />
          ))}
        </ul>
        <div className="flex min-h-30 items-center justify-end gap-6 px-12 pb-6">
          {confirming ? (
            <>
              <span className="text-sm text-fg-muted">Remove all {String(queue.length)} queued messages?</span>
              <Button size="sm" variant="ghost" disabled={clearing} onClick={() => setConfirming(false)}>
                Keep them
              </Button>
              <Button size="sm" variant="danger" disabled={clearing} onClick={() => void clearAll()}>
                Remove all
              </Button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirming(true)} className="text-sm text-danger transition-ui hover:underline">
              Clear all
            </button>
          )}
        </div>
      </Collapse>
    </section>
  );
}
