import { Fragment, lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { FilePreviewView } from '@shared/schemas/panels';
import { Button } from '../../components/Button';
import { invoke, onEvent } from '../../lib/ipc';
import { useEditorDrafts } from './editorDrafts';

const DiskCompare = lazy(() => import('./DiskCompare'));

/** A draft without unsaved edits follows the file on disk. One with edits keeps them; DiskChangeBar offers the choice. */
export function takeDisk(key: string, preview: FilePreviewView): void {
  const drafts = useEditorDrafts.getState();
  const draft = drafts.drafts[key];
  if (!draft || draft.content !== draft.original || !preview.revision || preview.content === null || preview.revision === draft.revision) return;
  drafts.reload(key, preview.content, preview.revision);
}

/**
 * Keeps the file the Files panel shows in step with the disk. The main process watches it from the revision the
 * panel has (`revision`); when it changes there, it is read again, a draft without unsaved edits takes it, and
 * `shown` gets what was read.
 */
export function useLiveFile(sessionId: string, path: string | null, revision: string | undefined, shown: (preview: FilePreviewView) => void): void {
  const latest = useRef(shown);
  useEffect(() => {
    latest.current = shown;
  });
  useEffect(() => {
    void invoke('files:watch', { sessionId, files: path && revision ? [{ path, revision }] : [] }).catch(() => undefined);
  }, [sessionId, path, revision]);
  useEffect(() => () => void invoke('files:watch', { sessionId, files: [] }).catch(() => undefined), [sessionId]);
  useEffect(() => {
    if (!path) return;
    let live = true;
    const off = onEvent((event) => {
      if (event.type !== 'files:changed' || event.sessionId !== sessionId || event.path !== path) return;
      // A file that can no longer be read keeps what is shown; saving it says why.
      void invoke('files:read', { sessionId, path }).then(
        (preview) => {
          if (!live) return;
          takeDisk(`${sessionId}:${path}`, preview);
          latest.current(preview);
        },
        () => undefined
      );
    });
    return () => {
      live = false;
      off();
    };
  }, [sessionId, path]);
}

/**
 * Shown above the editor when the file changed on disk while its draft has unsaved edits (`disk` is the file as
 * read last, null when the editor is not open). Compare shows the two side by side, Keep mine lets the next save
 * replace the file on disk after a confirmation, and Take theirs puts the file on disk in the draft (Ctrl+Z steps back).
 */
export function DiskChangeBar({ draftKey, path, disk }: { draftKey: string; path: string; disk: FilePreviewView | null }) {
  const draft = useEditorDrafts((s) => s.drafts[draftKey]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  if (!disk?.revision || disk.content === null || !draft || draft.content === draft.original || draft.revision === disk.revision) return null;
  const { content, revision } = disk;
  // The bar goes once the choice is made; the keyboard goes back to the code.
  const choose = (apply: () => void): void => {
    const pane = bar.current?.parentElement;
    apply();
    setComparing(false);
    requestAnimationFrame(() => pane?.querySelector<HTMLElement>('.monaco-editor [aria-roledescription="editor"]')?.focus());
  };
  const keep = (): void => choose(() => useEditorDrafts.getState().saved(draftKey, content, revision));
  const take = (): void => choose(() => useEditorDrafts.getState().reload(draftKey, content, revision));
  const asking = confirming === revision;
  return (
    <div ref={bar} role="region" aria-label="Changed on disk" className="flex shrink-0 flex-wrap items-center gap-6 border-t border-border px-10 py-6">
      <p role="status" className="min-w-0 flex-1 text-sm text-amber-fg">
        {asking ? 'Your next save will replace the file on disk with your version.' : 'This file changed on disk while you were editing it.'}
      </p>
      {/* Keyed apart, so the confirming buttons are new ones and the first of them takes the keyboard. */}
      {asking ? (
        <Fragment key="confirm">
          <Button size="xs" variant="secondary" autoFocus onClick={keep}>
            Keep mine
          </Button>
          <Button size="xs" variant="ghost" onClick={() => { setConfirming(null); requestAnimationFrame(() => keepButton.current?.focus()); }}>
            Cancel
          </Button>
        </Fragment>
      ) : (
        <Fragment key="choose">
          <Button size="xs" variant="ghost" onClick={() => setComparing(true)} title="Your draft beside the file on disk">
            Compare
          </Button>
          <Button ref={keepButton} size="xs" variant="ghost" onClick={() => setConfirming(revision)} title="The next save replaces the file on disk">
            Keep mine
          </Button>
          <Button size="xs" variant="ghost" onClick={take} title="Put the file on disk in the editor; Ctrl+Z steps back">
            Take theirs
          </Button>
        </Fragment>
      )}
      {comparing ? (
        <Suspense fallback={null}>
          <DiskCompare path={path} disk={content} draft={draft.content} onClose={() => setComparing(false)} />
        </Suspense>
      ) : null}
    </div>
  );
}
