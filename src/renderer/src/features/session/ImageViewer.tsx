import * as RD from '@radix-ui/react-dialog';
import { Minus, Plus, X } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { MediaFile } from '@shared/schemas/toolDisplay';
import { Button, IconButton } from '../../components/Button';
import { invoke } from '../../lib/ipc';
import { logError } from '../../lib/log';
import { fileName } from './transcriptModel';

const STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

/** The next zoom step up or down from the one shown; "fit" counts as the picture's own size. */
export function nextImageZoom(zoom: number | 'fit', direction: 1 | -1): number {
  const from = zoom === 'fit' ? 1 : zoom;
  const next = direction === 1 ? STEPS.find((s) => s > from) : STEPS.findLast((s) => s < from);
  return next ?? from;
}

function ViewerBody({ sessionId, folder, file, actions }: { sessionId: string; folder: string | null; file: MediaFile; actions: ReactNode }) {
  const preview = file.thumb ? `data:image/jpeg;base64,${file.thumb}` : null;
  // The preview shows at once; the file itself replaces it when the session has a folder to read it from.
  const [full, setFull] = useState<string | null>(null);
  const [natural, setNatural] = useState<number | null>(null);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  useEffect(() => {
    if (!folder) return;
    let current = true;
    invoke('files:previewUrl', { sessionId, path: file.path })
      .then(({ url }) => current && setFull(url))
      .catch((error: unknown) => logError(`Could not load ${file.path} at full size`, error));
    return () => {
      current = false;
    };
  }, [sessionId, folder, file.path]);
  const src = full ?? preview;
  const name = fileName(file.path);
  const step = (direction: 1 | -1): void => setZoom(nextImageZoom(zoom, direction));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === '+' || event.key === '=') step(1);
    else if (event.key === '-') step(-1);
    else if (event.key === '0') setZoom('fit');
    else return;
    event.preventDefault();
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <header className="flex h-44 shrink-0 items-center gap-8 border-b border-border-subtle pr-8 pl-16">
        <RD.Title className="min-w-0 flex-1 truncate text-md font-semibold text-fg-strong">{name}</RD.Title>
        <div role="toolbar" aria-label="Picture view" className="flex shrink-0 items-center gap-2">
          <IconButton label="Zoom out" shortcut="-" onClick={() => step(-1)}>
            <Minus className="size-14" />
          </IconButton>
          <span aria-live="polite" className="w-44 text-center text-sm text-fg-secondary tabular-nums">
            {zoom === 'fit' ? 'Fit' : `${String(Math.round(zoom * 100))}%`}
          </span>
          <IconButton label="Zoom in" shortcut="+" onClick={() => step(1)}>
            <Plus className="size-14" />
          </IconButton>
          <Button size="sm" variant="ghost" disabled={zoom === 'fit'} onClick={() => setZoom('fit')}>
            Fit
          </Button>
        </div>
        {actions}
        <RD.Close asChild>
          <IconButton label="Close" tooltip={false}>
            <X className="size-14" />
          </IconButton>
        </RD.Close>
      </header>
      <div className="min-h-0 flex-1 overflow-auto bg-sunken">
        {src ? (
          <div className="flex min-h-full min-w-full p-16" style={zoom === 'fit' ? { height: '100%' } : { width: 'max-content' }}>
            <img
              key={src}
              src={src}
              alt={`Generated: ${name}`}
              onLoad={(event) => setNatural(event.currentTarget.naturalWidth)}
              style={zoom === 'fit' || natural === null ? undefined : { width: natural * zoom, maxWidth: 'none' }}
              className={zoom === 'fit' ? 'graft-reveal m-auto max-h-full max-w-full rounded-sm object-contain' : 'm-auto rounded-sm'}
            />
          </div>
        ) : (
          <p className="flex h-full items-center justify-center px-24 text-center text-base text-fg-muted">This file has no preview.</p>
        )}
      </div>
    </div>
  );
}

/** A generated picture, large, with zoom. Open while `file` is given; `actions` are the card's own buttons for it. */
export function ImageViewer({ sessionId, folder, file, actions, onClose }: { sessionId: string; folder: string | null; file: MediaFile | null; actions: (file: MediaFile) => ReactNode; onClose: () => void }) {
  // The one last shown stays while the dialog leaves, so it does not empty before it has gone.
  const [last, setLast] = useState(file);
  if (file && file !== last) setLast(file);
  const shown = file ?? last;
  return (
    <RD.Root open={file !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <RD.Portal>
        <RD.Overlay className="overlay-scrim fixed inset-0 z-[var(--g-z-dialog)] bg-overlay" />
        <RD.Content
          aria-describedby={undefined}
          className="overlay-dialog fixed top-1/2 left-1/2 z-[var(--g-z-dialog)] flex h-[88vh] w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-surface text-fg shadow-popover outline-none"
        >
          {shown ? <ViewerBody key={shown.path} sessionId={sessionId} folder={folder} file={shown} actions={actions(shown)} /> : null}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
