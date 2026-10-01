import { useState } from 'react';
import { PenLine } from 'lucide-react';
import { Button } from '../../components/Button';
import { Dialog, DialogContent } from '../../components/Dialog';
import { Checkbox, TextArea } from '../../components/Field';
import { Spinner } from '../../components/ContextRing';
import { errorText, invoke } from '../../lib/ipc';
import { useToasts } from '../../stores/toasts';

interface CommitDialogProps {
  sessionId: string;
  open: boolean;
  /** Push after committing ("Commit & push"). */
  push: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}

/** Commit (and optionally push) the session's changes, with a model-suggested message. */
export function CommitDialog({ sessionId, open, push, onOpenChange, onDone }: CommitDialogProps) {
  const [message, setMessage] = useState('');
  const [stageAll, setStageAll] = useState(true);
  const [busy, setBusy] = useState<'suggest' | 'commit' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const suggest = async (): Promise<void> => {
    setBusy('suggest');
    setError(null);
    try {
      setMessage((await invoke('git:suggestCommitMessage', { sessionId })).message);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const commit = async (): Promise<void> => {
    setBusy('commit');
    setError(null);
    try {
      const { sha } = await invoke('git:commit', { sessionId, message, stageAll });
      let pushed: string | null = null;
      if (push) pushed = (await invoke('git:push', { sessionId })).branch;
      useToasts.getState().push({
        tone: 'success',
        title: pushed ? `Committed and pushed ${pushed}` : 'Committed',
        description: `${sha.slice(0, 8)} ${message.split('\n')[0] ?? ''}`
      });
      setMessage('');
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={push ? 'Commit and push' : 'Commit changes'}
        description="Commits run your repository's git hooks."
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy !== null}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void commit()} disabled={busy !== null || message.trim().length === 0}>
              {busy === 'commit' ? <Spinner size={12} label="Committing" /> : null}
              {push ? 'Commit & push' : 'Commit'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-10">
          <TextArea
            label="Message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={5}
            autoFocus
            placeholder="Summarize the change in one line, then add details if useful."
            className="font-mono text-sm"
          />
          <div className="flex items-center justify-between gap-8">
            <Checkbox label="Stage all changes first" checked={stageAll} onChange={(e) => setStageAll(e.target.checked)} />
            <Button size="sm" variant="secondary" onClick={() => void suggest()} disabled={busy !== null} leading={busy === 'suggest' ? <Spinner size={12} label="Writing" /> : <PenLine className="size-14" />}>
              Suggest a message
            </Button>
          </div>
          {error ? (
            <p role="alert" className="selectable text-base text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
