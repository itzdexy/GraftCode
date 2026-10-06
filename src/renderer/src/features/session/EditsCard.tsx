import { useState } from 'react';
import { ChevronRight, FileCode2, FilePlus2 } from 'lucide-react';
import { Collapse } from '../../components/Collapse';
import { cn } from '../../lib/cn';
import { EditDiff } from './ToolDetail';
import { DiffCount } from './ToolGroup';
import { fileName, type EditedFile } from './transcriptModel';

const SHOWN = 4;

function FileRow({ file }: { file: EditedFile }) {
  const [open, setOpen] = useState(false);
  const Icon = file.created ? FilePlus2 : FileCode2;
  return (
    <li className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        title={file.path}
        onClick={() => setOpen(!open)}
        className="flex h-26 items-center gap-8 px-12 text-left text-md transition-ui hover:bg-hover"
      >
        <Icon className="size-13 shrink-0 text-icon-muted" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium text-fg">{fileName(file.path)}</span>
        <DiffCount added={file.added} removed={file.removed} pill />
        <ChevronRight className={cn('size-14 shrink-0 text-icon-muted transition-transform duration-[var(--g-duration-fast)]', open && 'rotate-90')} aria-hidden="true" />
      </button>
      <Collapse open={open} className="flex flex-col gap-6 px-12 pb-8">
        {file.patches.map((patch, i) => (
          <EditDiff key={i} patch={patch} />
        ))}
      </Collapse>
    </li>
  );
}

/** The files a turn changed, with their line counts; each opens to its diff. */
export function EditsCard({ files }: { files: EditedFile[] }) {
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
        <DiffCount added={added} removed={removed} pill />
      </header>
      <ul className="flex flex-col py-2">
        {shown.map((file) => (
          <FileRow key={file.path} file={file} />
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
