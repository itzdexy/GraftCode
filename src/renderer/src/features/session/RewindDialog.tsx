import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { RewindMode, RewindPreview } from '@shared/schemas/rewind';
import { Button } from '../../components/Button';
import { Dialog, DialogContent } from '../../components/Dialog';
import { ErrorState, LoadingState } from '../../components/States';
import { cn } from '../../lib/cn';
import { errorText, invoke } from '../../lib/ipc';
import { useSessions } from '../../stores/sessions';
import { useToasts } from '../../stores/toasts';
import { useUi } from '../../stores/ui';

interface Target {
  sessionId: string;
  messageId: string;
  /** Chats only rewind the conversation (edit and resend). */
  chat: boolean;
}

export const useRewind = create<{ target: Target | null; open: (target: Target) => void; close: () => void }>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null })
}));

const MODES: Array<{ value: RewindMode; label: string; description: string }> = [
  { value: 'both', label: 'Files and conversation', description: 'Restore the files and remove the messages from this point on.' },
  { value: 'conversation', label: 'Conversation only', description: 'Remove the messages from this point on; files stay as they are.' },
  { value: 'files', label: 'Files only', description: 'Restore the files to how they were before this message; keep the conversation.' }
];

const CHANGE_LABEL = { restore: 'Restore', recreate: 'Recreate', delete: 'Delete' } as const;

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; preview: RewindPreview };

function RewindBody({ target, onClose }: { target: Target; onClose: () => void }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [mode, setMode] = useState<RewindMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke('sessions:rewindPreview', { sessionId: target.sessionId, messageId: target.messageId })
      .then((preview) => {
        if (!cancelled) setLoad({ state: 'ready', preview });
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoad({ state: 'error', message: errorText(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  const preview = load.state === 'ready' ? load.preview : null;
  const filesAvailable = preview?.files !== null && preview !== null;
  const chosen: RewindMode = target.chat ? 'conversation' : (mode ?? (filesAvailable ? 'both' : 'conversation'));

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await invoke('sessions:rewind', { sessionId: target.sessionId, messageId: target.messageId, mode: chosen });
      await useSessions.getState().open(target.sessionId, { reset: true });
      if (chosen !== 'files' && result.restoredText) {
        useUi.getState().setDraft(target.sessionId, result.restoredText);
        requestAnimationFrame(() => useUi.getState().focusComposer?.());
      }
      const fileCount = result.files?.length ?? 0;
      useToasts.getState().push({
        tone: 'success',
        title: target.chat ? 'Ready to edit' : 'Rewound',
        description: [
          result.messagesRemoved > 0 ? `${result.messagesRemoved} ${result.messagesRemoved === 1 ? 'message' : 'messages'} removed` : null,
          chosen !== 'conversation' ? `${fileCount} ${fileCount === 1 ? 'file' : 'files'} restored` : null,
          result.undoCheckpointId ? 'A safety snapshot of your files was saved first' : null
        ]
          .filter(Boolean)
          .join(' · ')
      });
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <DialogContent
      title={target.chat ? 'Edit this message?' : 'Rewind to this message?'}
      description={
        target.chat
          ? 'The replies after it are removed and the message goes back into the message box to edit and resend.'
          : 'Graft took a snapshot of your files before this message was sent.'
      }
      className="w-[min(540px,calc(100vw-48px))]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void run()} disabled={busy || preview === null}>
            {target.chat ? 'Edit message' : 'Rewind'}
          </Button>
        </>
      }
    >
      {load.state === 'loading' ? <LoadingState label="Checking what would change…" /> : null}
      {load.state === 'error' ? <ErrorState message={load.message} /> : null}
      {preview ? (
        <div className="flex flex-col gap-14">
          {target.chat ? null : (
            <div role="radiogroup" aria-label="What to rewind" className="flex flex-col gap-6">
              {MODES.map((m) => {
                const disabled = m.value !== 'conversation' && !filesAvailable;
                const selected = chosen === m.value;
                return (
                  <button
                    key={m.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={disabled}
                    onClick={() => setMode(m.value)}
                    className={cn(
                      'flex flex-col items-start rounded-md border px-10 py-6 text-left transition-ui disabled:opacity-50',
                      selected ? 'border-border-strong bg-hover' : 'border-border hover:bg-raised'
                    )}
                  >
                    <span className="text-base text-fg">{m.label}</span>
                    <span className="text-sm text-fg-muted">{m.description}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex flex-col gap-4 text-base">
            <p className="text-fg-secondary">
              {preview.messagesRemoved > 0
                ? `${preview.messagesRemoved} ${preview.messagesRemoved === 1 ? 'message' : 'messages'} from this point on will be removed.`
                : 'No messages come after this one.'}
            </p>
            {target.chat ? null : preview.files === null ? (
              <p className="text-fg-muted">There is no file snapshot for this message, so only the conversation can be rewound.</p>
            ) : preview.files.length === 0 ? (
              <p className="text-fg-muted">Files are unchanged since this message.</p>
            ) : (
              <>
                <p className="text-fg-muted">Files that would change:</p>
                <ul className="selectable max-h-[180px] overflow-y-auto rounded-sm bg-sunken px-10 py-6 font-mono text-sm">
                  {preview.files.map((f) => (
                    <li key={f.path} className="flex gap-8">
                      <span className={cn('w-64 shrink-0', f.change === 'delete' ? 'text-diff-del' : f.change === 'recreate' ? 'text-diff-add' : 'text-fg-muted')}>
                        {CHANGE_LABEL[f.change]}
                      </span>
                      <span className="min-w-0 truncate text-fg-secondary">{f.path}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
          {error ? (
            <p role="alert" className="selectable text-base text-danger">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </DialogContent>
  );
}

/** Rewind (code) / edit-and-resend (chat) confirmation with a preview of what changes. */
export function RewindDialog() {
  const target = useRewind((s) => s.target);
  const close = useRewind((s) => s.close);
  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : close())}>
      {target ? <RewindBody key={`${target.sessionId}:${target.messageId}`} target={target} onClose={close} /> : null}
    </Dialog>
  );
}
