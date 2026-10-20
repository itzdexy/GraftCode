import { useState } from 'react';
import { create } from 'zustand';
import type { SessionGroup, SessionSummary } from '@shared/schemas/sessions';
import { Button } from '../../components/Button';
import { Dialog, DialogContent } from '../../components/Dialog';
import { Checkbox, TextField } from '../../components/Field';
import { errorText, invoke, RequestError } from '../../lib/ipc';
import { useSessions } from '../../stores/sessions';
import { useToasts } from '../../stores/toasts';

type GroupPending =
  | { kind: 'new-group'; session: SessionSummary | null }
  | { kind: 'rename-group'; group: SessionGroup }
  | { kind: 'delete-group'; group: SessionGroup };

type Pending = { kind: 'archive' | 'delete'; session: SessionSummary } | GroupPending | null;

export const useSessionDialog = create<{
  pending: Pending;
  open: (kind: 'archive' | 'delete', session: SessionSummary) => void;
  openGroup: (pending: GroupPending) => void;
  close: () => void;
}>((set) => ({
  pending: null,
  open: (kind, session) => set({ pending: { kind, session } }),
  openGroup: (pending) => set({ pending }),
  close: () => set({ pending: null })
}));

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

/** Makes a group (filing a session into it when one is given) or renames one. */
function GroupNameBody({ group, session, onDone }: { group: SessionGroup | null; session: SessionSummary | null; onDone: () => void }) {
  const [name, setName] = useState(group?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const trimmed = name.trim();

  const run = async (): Promise<void> => {
    if (trimmed.length === 0) return;
    setBusy(true);
    setFailure(null);
    try {
      if (group) {
        await invoke('sessions:renameGroup', { id: group.id, name: trimmed });
      } else {
        const made = await invoke('sessions:createGroup', { name: trimmed });
        if (session) await invoke('sessions:setGroup', { id: session.id, groupId: made.id });
      }
      await useSessions.getState().loadGroups();
      onDone();
    } catch (error) {
      setFailure(errorText(error));
      setBusy(false);
    }
  };

  return (
    <DialogContent
      title={group ? `Rename “${group.name}”` : 'New group'}
      description={
        group
          ? 'Only the group’s name changes.'
          : session
            ? `“${session.title}” is filed into it right away.`
            : 'File sessions under it from their ⋮ menu, under Move to group.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onDone} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void run()} disabled={busy || trimmed.length === 0}>
            {group ? 'Rename' : 'Create'}
          </Button>
        </>
      }
    >
      <TextField
        label="Name"
        value={name}
        autoFocus
        maxLength={80}
        placeholder="Work, Research, Notes…"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void run();
        }}
        error={failure}
      />
    </DialogContent>
  );
}

/** Removes a group; the sessions in it are kept and go back to their ordinary lists. */
function DeleteGroupBody({ group, onDone }: { group: SessionGroup; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const count = useSessions((s) => Object.values(s.summaries).filter((other) => other.groupId === group.id).length);

  const run = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await invoke('sessions:deleteGroup', { id: group.id });
      await useSessions.getState().loadGroups();
      onDone();
    } catch (error) {
      setFailure(errorText(error));
      setBusy(false);
    }
  };

  return (
    <DialogContent
      title={`Remove the group “${group.name}”?`}
      description={
        count === 0
          ? 'The group is empty; nothing else changes.'
          : count === 1
            ? 'The session in it is kept and goes back to its ordinary list.'
            : `The ${String(count)} sessions in it are kept and go back to their ordinary lists.`
      }
      footer={
        <>
          <Button variant="ghost" onClick={onDone} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void run()} disabled={busy}>
            Remove group
          </Button>
        </>
      }
    >
      {failure ? (
        <p role="alert" className="selectable text-base text-danger">
          {failure}
        </p>
      ) : null}
    </DialogContent>
  );
}

/** Confirmation dialogs for archive, delete, and the groups sessions are filed under. */
export function SessionDialogs() {
  const pending = useSessionDialog((s) => s.pending);
  const close = useSessionDialog((s) => s.close);
  return (
    <Dialog open={pending !== null} onOpenChange={(open) => (open ? undefined : close())}>
      {pending?.kind === 'archive' ? <ArchiveBody key={pending.session.id} session={pending.session} onDone={close} /> : null}
      {pending?.kind === 'delete' ? <DeleteBody key={pending.session.id} session={pending.session} onDone={close} /> : null}
      {pending?.kind === 'new-group' ? <GroupNameBody key="new-group" group={null} session={pending.session} onDone={close} /> : null}
      {pending?.kind === 'rename-group' ? <GroupNameBody key={pending.group.id} group={pending.group} session={null} onDone={close} /> : null}
      {pending?.kind === 'delete-group' ? <DeleteGroupBody key={pending.group.id} group={pending.group} onDone={close} /> : null}
    </Dialog>
  );
}
