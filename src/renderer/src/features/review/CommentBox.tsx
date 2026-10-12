import { useState, type KeyboardEvent } from 'react';
import { MessageSquare } from 'lucide-react';
import { Button } from '../../components/Button';
import { cn } from '../../lib/cn';
import { MAX_TEXT, type ReviewComment } from './reviewModel';

/**
 * The box a comment for the agent is written in: under a line of a diff, or
 * (`plain`) in the editor's dialog. Ctrl+Enter saves and Escape cancels. Escape
 * stays in the box: the page would take it for "stop the running session".
 */
export function CommentBox({ initial = '', plain = false, onSave, onCancel }: { initial?: string; plain?: boolean; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  const written = text.trim();
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && written.length > 0) {
      event.preventDefault();
      onSave(written);
    }
  };
  return (
    // In a dialog the dialog is the frame; under a line of a diff the box has its own.
    <div className={cn('flex flex-col gap-6 font-sans', !plain && 'motion-step rounded-md border border-border bg-surface p-8')}>
      <textarea
        autoFocus
        aria-label="Comment for the agent"
        placeholder="What should change here?"
        value={text}
        maxLength={MAX_TEXT}
        rows={3}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        className="selectable max-h-[240px] min-h-[56px] w-full resize-y rounded-sm border border-border-subtle bg-bg px-8 py-6 text-base leading-[1.45] text-fg outline-none placeholder:text-fg-faint focus-visible:border-accent"
      />
      <div className="flex items-center justify-end gap-6">
        <Button size="sm" variant="ghost" onClick={onCancel} title="Esc">
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={written.length === 0} onClick={() => onSave(written)} title="Ctrl+Enter">
          {initial.length > 0 ? 'Save comment' : 'Add comment'}
        </Button>
      </div>
    </div>
  );
}

/** A comment that waits for the next message, under the line it is about. Edit turns it back into the box. */
export function CommentNote({ comment, onEdit, onDelete }: { comment: ReviewComment; onEdit: (text: string) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <CommentBox
        initial={comment.text}
        onSave={(text) => {
          onEdit(text);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <div className="motion-step flex items-start gap-8 rounded-md border border-border-card bg-surface px-10 py-6 font-sans">
      <MessageSquare className="mt-2 size-13 shrink-0 text-icon-muted" aria-hidden="true" />
      <p className="selectable min-w-0 flex-1 text-base leading-[1.45] break-words whitespace-pre-wrap text-fg">{comment.text}</p>
      <span className="flex shrink-0 gap-2 text-sm">
        <button type="button" onClick={() => setEditing(true)} className="rounded-xs px-6 text-fg-muted transition-ui hover:bg-hover hover:text-fg">
          Edit
        </button>
        <button type="button" onClick={onDelete} className="rounded-xs px-6 text-fg-muted transition-ui hover:bg-hover hover:text-fg">
          Delete
        </button>
      </span>
    </div>
  );
}
