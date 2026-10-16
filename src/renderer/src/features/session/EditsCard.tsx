import { useState } from 'react';
import { ChevronRight, ExternalLink, FileCode2, FilePlus2 } from 'lucide-react';
import { IconButton } from '../../components/Button';
import { Collapse } from '../../components/Collapse';
import { cn } from '../../lib/cn';
import { firstChangedLine } from '../diff/diffModel';
import { EditDiff } from './ToolDetail';
import { DiffCount } from './ToolGroup';
import { fileName, type EditedFile } from './transcriptModel';

const SHOWN = 4;
/** A file outside the session's folder is named from the home folder or the drive; the Files panel can't show it. */
const OUTSIDE = /^(~|\/|[A-Za-z]:)/;

function FileRow({ file, onOpen }: { file: EditedFile; onOpen: ((path: string, line: number) => void) | null }) {
  const [open, setOpen] = useState(false);
  const Icon = file.created ? FilePlus2 : FileCode2;
  return (
    <li className="flex flex-col">
      <div className="flex items-center transition-ui hover:bg-hover">
        <button
          type="button"
          aria-expanded={open}
          title={file.path}
          onClick={() => setOpen(!open)}
          className={cn('flex h-26 min-w-0 flex-1 items-center gap-8 pl-12 text-left text-md', onOpen ? 'pr-6' : 'pr-12')}
        >
          <Icon className="size-13 shrink-0 text-icon-muted" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-medium text-fg">{fileName(file.path)}</span>
          <DiffCount added={file.added} removed={file.removed} pill />
          <ChevronRight className={cn('size-14 shrink-0 text-icon-muted transition-transform duration-[var(--g-duration-fast)]', open && 'rotate-90')} aria-hidden="true" />
        </button>
        {onOpen && !OUTSIDE.test(file.path) ? (
          <IconButton label={`Open ${fileName(file.path)}`} size="xs" className="mr-8 text-icon-muted" onClick={() => onOpen(file.path, firstChangedLine(file.patches[0] ?? ''))}>
            <ExternalLink className="size-13" />
          </IconButton>
        ) : null}
      </div>
      <Collapse open={open} className="flex flex-col gap-6 px-12 pb-8">
        {file.patches.map((patch, i) => (
          <EditDiff key={i} patch={patch} path={file.path} />
        ))}
      </Collapse>
    </li>
  );
}

/**
 * The files a turn changed, with their line counts; each opens to its diff.
 * `onUndo` puts the files back as they were before the turn (asked for on the
 * newest card only, where that is exactly this turn's changes). `onOpen`
 * shows a file where its first change is.
 */
export function EditsCard({ files, onUndo = null, onOpen = null }: { files: EditedFile[]; onUndo?: (() => void) | null; onOpen?: ((path: string, line: number) => void) | null }) {
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
          <FileRow key={file.path} file={file} onOpen={onOpen} />
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
