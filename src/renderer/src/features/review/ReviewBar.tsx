import { useState } from 'react';
import { ChevronUp, MessageSquare, Trash2 } from 'lucide-react';
import { Button, IconButton } from '../../components/Button';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/Popover';
import { cn } from '../../lib/cn';
import { commentsOf, useReview } from '../../stores/review';
import { commentPlace, commentsLabel, inOrder } from './reviewModel';

/**
 * The comments that wait for the session's next message, above the message
 * box: how many there are, and on a click each with its place, its text and a
 * way to delete it. They go with whatever is sent next; Send comments sends
 * them now, with nothing else. Nothing is drawn while there are none.
 */
export function ReviewBar({ sessionId, onSend }: { sessionId: string; onSend: () => void }) {
  const comments = useReview((state) => commentsOf(state, sessionId));
  const [open, setOpen] = useState(false);
  if (comments.length === 0) return null;
  return (
    <section aria-label="Comments waiting for your next message" className="motion-step rounded-lg border border-border bg-raised">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="flex min-h-34 w-full min-w-0 items-center gap-8 rounded-lg py-2 pr-9 pl-9 text-left text-base transition-ui hover:bg-hover">
            <MessageSquare className="size-14 shrink-0 text-icon-muted" aria-hidden="true" />
            <span className="shrink-0 font-medium text-fg">{commentsLabel(comments.length)}</span>
            <span className="min-w-0 flex-1 truncate text-sm text-fg-muted">{comments.length === 1 ? 'goes' : 'go'} to Graft with your next message</span>
            <ChevronUp className={cn('size-12 shrink-0 text-icon-muted transition-transform duration-[var(--g-duration-fast)]', open && 'rotate-180')} aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          // The keyboard goes to the list as a whole: on its first button, that button's tooltip would open with the list.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
          }}
          className="flex max-h-[min(420px,60vh)] w-[min(520px,calc(100vw-48px))] flex-col"
        >
          <ul aria-label="Comments for the agent" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-6">
            {inOrder(comments).map((comment) => (
              <li key={comment.id} className="flex items-start gap-8 rounded-md py-6 pr-4 pl-8 transition-ui hover:bg-hover">
                <div className="min-w-0 flex-1">
                  {/* Cut at the start, so a long path still ends in its file name and line. */}
                  <p className="truncate text-left font-mono text-2xs text-fg-muted [direction:rtl]" title={commentPlace(comment)}>
                    <bdi>{commentPlace(comment)}</bdi>
                  </p>
                  <p className="selectable mt-2 text-base leading-[1.45] break-words whitespace-pre-wrap text-fg">{comment.text}</p>
                </div>
                <IconButton label="Delete comment" size="xs" onClick={() => useReview.getState().remove(sessionId, comment.id)}>
                  <Trash2 className="size-13" />
                </IconButton>
              </li>
            ))}
          </ul>
          <div className="flex shrink-0 items-center justify-between gap-8 border-t border-border-subtle px-10 py-8">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                useReview.getState().clear(sessionId);
              }}
            >
              Remove all
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setOpen(false);
                onSend();
              }}
            >
              Send comments
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </section>
  );
}
