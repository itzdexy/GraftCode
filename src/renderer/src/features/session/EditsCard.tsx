import { useState } from 'react';
import { ChevronRight, ExternalLink, FileCode2, FilePlus2, Undo2 } from 'lucide-react';
import { IconButton } from '../../components/Button';
import { Collapse } from '../../components/Collapse';
import { cn } from '../../lib/cn';
import { firstChangedLine } from '../diff/diffModel';
import { useRewind } from './RewindDialog';
import { EditDiff } from './ToolDetail';
import { DiffCount } from './ToolGroup';
import { fileName, type EditedFile } from './transcriptModel';
import { fileUndoKey, hunkUndoKey, undoHunk, useTurnUndo } from './turnUndo';

const SHOWN = 4;
/** A file outside the session's folder is named from the home folder or the drive; the Files panel can't show it. */
const OUTSIDE = /^(~|\/|[A-Za-z]:)/;

/** What a finished turn's card can undo in a code session: each file from the turn's snapshot, and each change by itself. */
export interface TurnUndo {
  sessionId: string;
  /** The message that started the turn; null for a turn the user did not type. */
  messageId: string | null;
  /** Whether the snapshot of the files before the turn exists: a file goes back from it. */
  snapshot: boolean;
}

function HunkUndo({ sessionId, callId, hunk, name }: { sessionId: string; callId: string; hunk: number; name: string }) {
  const key = hunkUndoKey(sessionId, callId, hunk);
  const undone = useTurnUndo((s) => s.undone[key] === true);
  const busy = useTurnUndo((s) => s.busy[key] === true);
  if (undone) return <span className="shrink-0 px-4 font-sans text-2xs text-fg-muted">Undone</span>;
  return (
    <button
      type="button"
      disabled={busy}
      aria-label={`Undo this change to ${name}`}
      onClick={() => void undoHunk(sessionId, callId, hunk, name)}
      className="shrink-0 rounded-xs px-4 font-sans text-2xs hover:bg-hover hover:text-fg disabled:opacity-50"
    >
      Undo
    </button>
  );
}

function FileRow({ file, onOpen, undo }: { file: EditedFile; onOpen: ((path: string, line: number) => void) | null; undo: TurnUndo | null }) {
  const [open, setOpen] = useState(false);
  const Icon = file.created ? FilePlus2 : FileCode2;
  const name = fileName(file.path);
  const inside = !OUTSIDE.test(file.path);
  const sessionId = undo?.sessionId ?? null;
  const messageId = undo?.messageId ?? null;
  const fileKey = sessionId !== null && messageId !== null ? fileUndoKey(sessionId, messageId, file.path) : null;
  const undone = useTurnUndo((s) => fileKey !== null && s.undone[fileKey] === true);
  const undoFile =
    sessionId !== null && messageId !== null && fileKey !== null && undo?.snapshot === true && inside && !undone
      ? () => useRewind.getState().open({ sessionId, messageId, chat: false, mode: 'files', paths: [file.path], onDone: () => useTurnUndo.getState().mark([fileKey]) })
      : null;
  // A file the turn created goes as a whole; one already put back has no changes left to take out.
  const hunkUndo = undo && inside && !file.created && !undone ? undo.sessionId : null;
  const showOpen = onOpen !== null && inside;
  return (
    <li className="flex flex-col">
      <div className="flex items-center transition-ui hover:bg-hover">
        <button
          type="button"
          aria-expanded={open}
          title={file.path}
          onClick={() => setOpen(!open)}
          className={cn('flex h-26 min-w-0 flex-1 items-center gap-8 pl-12 text-left text-md', showOpen || undoFile || undone ? 'pr-6' : 'pr-12')}
        >
          <Icon className="size-13 shrink-0 text-icon-muted" aria-hidden="true" />
          <span className={cn('min-w-0 flex-1 truncate font-medium', undone ? 'text-fg-muted' : 'text-fg')}>{name}</span>
          <DiffCount added={file.added} removed={file.removed} pill />
          <ChevronRight className={cn('size-14 shrink-0 text-icon-muted transition-transform duration-[var(--g-duration-fast)]', open && 'rotate-90')} aria-hidden="true" />
        </button>
        {showOpen || undoFile || undone ? (
          <span className="mr-8 flex shrink-0 items-center gap-2">
            {undone ? <span className="px-4 text-sm text-fg-muted">Undone</span> : null}
            {undoFile ? (
              <IconButton label={`Undo changes to ${name}`} size="xs" className="text-icon-muted" onClick={undoFile}>
                <Undo2 className="size-13" />
              </IconButton>
            ) : null}
            {showOpen ? (
              <IconButton label={`Open ${name}`} size="xs" className="text-icon-muted" onClick={() => onOpen(file.path, firstChangedLine(file.patches[0] ?? ''))}>
                <ExternalLink className="size-13" />
              </IconButton>
            ) : null}
          </span>
        ) : null}
      </div>
      <Collapse open={open} className="flex flex-col gap-6 px-12 pb-8">
        {file.patches.map((patch, i) => {
          const callId = file.calls[i];
          return (
            <EditDiff
              key={i}
              patch={patch}
              path={file.path}
              hunkActions={hunkUndo !== null && callId !== undefined ? (hunk) => <HunkUndo sessionId={hunkUndo} callId={callId} hunk={hunk} name={name} /> : undefined}
            />
          );
        })}
      </Collapse>
    </li>
  );
}

/**
 * The files a turn changed, with their line counts; each opens to its diff.
 * `onUndo` puts the files back as they were before the turn (asked for on the
 * newest card only, where that is exactly this turn's changes). `undo` lets a
 * finished turn's files be undone one by one, from the turn's snapshot, and
 * each change of a file by itself. `onOpen` shows a file where its first change is.
 */
export function EditsCard({
  files,
  onUndo = null,
  onOpen = null,
  undo = null
}: {
  files: EditedFile[];
  onUndo?: (() => void) | null;
  onOpen?: ((path: string, line: number) => void) | null;
  undo?: TurnUndo | null;
}) {
  const [all, setAll] = useState(false);
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const shown = all ? files : files.slice(0, SHOWN);
  return (
    <section aria-label="Files changed in this turn" className="overflow-hidden rounded-md border border-border-card">
      <header className="flex h-30 items-center gap-8 border-b border-border-subtle px-12 text-md">
        <FileCode2 className="size-13 shrink-0 text-icon" aria-hidden="true" />
        <span className="flex-1 font-medium text-fg-strong">
          {files.length === 1 ? 'Edited 1 file' : `Edited ${String(files.length)} files`}
        </span>
        {onUndo ? (
          <button type="button" onClick={onUndo} className="rounded-sm px-6 text-sm text-fg-muted transition-ui hover:bg-hover hover:text-fg">
            Undo
          </button>
        ) : null}
        <DiffCount added={added} removed={removed} pill />
      </header>
      <ul className="flex flex-col py-2">
        {shown.map((file) => (
          <FileRow key={file.path} file={file} onOpen={onOpen} undo={undo} />
        ))}
      </ul>
      {files.length > SHOWN ? (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="flex h-26 w-full items-center gap-6 border-t border-border-subtle px-12 text-left text-md text-fg-muted transition-ui hover:bg-hover hover:text-fg-secondary"
        >
          {all ? 'Show fewer' : `Show ${String(files.length - SHOWN)} more`}
        </button>
      ) : null}
    </section>
  );
}
