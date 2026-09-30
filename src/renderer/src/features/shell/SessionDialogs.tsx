import { useState } from 'react';
import { create } from 'zustand';
import type { SessionSummary } from '@shared/schemas/sessions';
import { Button } from '../../components/Button';
import { Dialog, DialogContent } from '../../components/Dialog';
import { Checkbox } from '../../components/Field';
import { errorText, invoke, RequestError } from '../../lib/ipc';
import { useToasts } from '../../stores/toasts';

type Pending = { kind: 'archive' | 'delete'; session: SessionSummary } | null;

export const useSessionDialog = create<{ pending: Pending; open: (kind: 'archive' | 'delete', session: SessionSummary) => void; close: () => void }>(
  (set) => ({
    pending: null,
    open: (kind, session) => set({ pending: { kind, session } }),
    close: () => set({ pending: null })
  })
);

interface Failure {
  message: string;
  dirty: boolean;
}

function failureOf(error: unknown): Failure {
  return { message: errorText(error), dirty: error instanceof RequestError && error.code === 'worktree_dirty' };
}

function ArchiveBody({ session, onDone }: { session: SessionSummary; onDone: () => void }) {
  const [removeWorktree, setRemoveWorktree] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const run = async (force: boolean): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await invoke('sessions:archive', {
        id: session.id,
        archived: true,
        removeWorktree: removeWorktree && session.worktreePath !== null,
        force
      });
      if (result.branchKeptReason) {
        useToasts.getState().push({ tone: 'info', title: `Kept branch ${session.branch ?? ''}`.trim(), description: result.branchKeptReason });
      }
      onDone();
    } catch (error) {
      setFailure(failureOf(error));
      setBusy(false);
    }
  };

  return (
    <DialogContent
      title={`Archive “${session.title}”?`}
      description="Archived sessions leave the sidebar. Show them again with the filter (Status → Archived)."
      footer={
        <>
          <Button variant="ghost" onClick={onDone} disabled={busy}>
            Cancel
          </Button>
          {failure?.dirty ? (
            <Button variant="danger" onClick={() => void run(true)} disabled={busy}>
              Discard changes and archive
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void run(false)} disabled={busy}>
              Archive
            </Button>
          )}
        </>
      }
    >
      {session.worktreePath ? (
        <div className="flex flex-col gap-6">
          <Checkbox label="Also remove its worktree" checked={removeWorktree} onChange={(e) => setRemoveWorktree(e.target.checked)} />
          <p className="selectable pl-15 text-sm break-all text-fg-muted">{session.worktreePath}</p>
          {session.branch ? (
            <p className="pl-15 text-sm text-fg-muted">
              The branch <span className="font-mono">{session.branch}</span> is deleted only if it has no unmerged commits.
            </p>
          ) : null}
        </div>
      ) : null}
      {failure ? (
        <p role="alert" className="selectable mt-12 text-base text-danger">
          {failure.message}
        </p>
      ) : null}
    </DialogContent>
  );
}

function DeleteBody({ session, onDone }: { session: SessionSummary; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const run = async (force: boolean): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await invoke('sessions:delete', { id: session.id, force });
      onDone();
    } catch (error) {
      setFailure(failureOf(error));
      setBusy(false);
    }
  };

  return (
    <DialogContent
      title={`Delete “${session.title}”?`}
      description="This permanently deletes the conversation and its checkpoints. It can't be undone."
      footer={
        <>
          <Button variant="ghost" onClick={onDone} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void run(failure?.dirty === true)} disabled={busy}>
            {failure?.dirty ? 'Delete and discard changes' : 'Delete'}
          </Button>
        </>
      }
    >
      {session.worktreePath ? (
        <p className="text-base text-fg-secondary">
          Its worktree is removed too:
          <span className="selectable mt-4 block text-sm break-all text-fg-muted">{session.worktreePath}</span>
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="selectable mt-12 text-base text-danger">
          {failure.message}
        </p>
      ) : null}
    </DialogContent>
  );
}

/** Confirmation dialogs for archive and delete, with the dirty-worktree safeguard. */
export function SessionDialogs() {
  const pending = useSessionDialog((s) => s.pending);
  const close = useSessionDialog((s) => s.close);
  return (
    <Dialog open={pending !== null} onOpenChange={(open) => (open ? undefined : close())}>
      {pending?.kind === 'archive' ? <ArchiveBody key={pending.session.id} session={pending.session} onDone={close} /> : null}
      {pending?.kind === 'delete' ? <DeleteBody key={pending.session.id} session={pending.session} onDone={close} /> : null}
    </Dialog>
  );
}
