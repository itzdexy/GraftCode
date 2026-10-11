import * as RD from '@radix-ui/react-dialog';
import { Download, ImageDown, Minus, Plus, X } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button, IconButton } from '../../components/Button';
import { Spinner } from '../../components/ContextRing';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../components/Menu';
import { ScaledFrame, useDiagramAddress, useDiagramCopies, usePageSize } from './DiagramFrame';
import { frameWidth, nextZoom, type MadeDiagram } from './diagramModel';

/** "Fit" may enlarge a small diagram, up to this. */
const MAX_FIT = 2;
/** The room kept around the page inside the viewer. */
const PADDING = 32;

function ViewerBody({ sessionId, diagram }: { sessionId: string; diagram: MadeDiagram }) {
  const address = useDiagramAddress(sessionId, diagram.source);
  const url = address.status === 'ready' ? address.url : null;
  const frame = useRef<HTMLIFrameElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const size = usePageSize(frame, url);
  const { busy, copy, save } = useDiagramCopies(sessionId, diagram);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const measure = (): void => setBox({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const width = frameWidth(diagram.width);
  // Until the page has said how tall it is, it is laid out unseen in a short frame, so what it reports is its own height.
  const height = size?.height ?? 100;
  const fit = box && size ? Math.max(0.1, Math.min(MAX_FIT, (box.width - PADDING) / width, (box.height - PADDING) / size.height)) : 1;
  const scale = zoom === 'fit' ? fit : zoom;
  const step = (direction: 1 | -1): void => setZoom(nextZoom(zoom, fit, direction));
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
        <div className="min-w-0 flex-1">
          <RD.Title className="truncate text-md font-semibold text-fg-strong">Diagram: {diagram.title}</RD.Title>
        </div>
        <div role="toolbar" aria-label="Diagram view" className="flex shrink-0 items-center gap-2">
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
        <Button size="sm" variant="ghost" disabled={busy !== null} leading={busy === 'copy' ? <Spinner size={12} label="Copying" /> : <ImageDown className="size-14" />} onClick={copy}>
          Copy image
        </Button>
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm" variant="ghost" disabled={busy !== null} leading={busy === 'save' ? <Spinner size={12} label="Saving" /> : <Download className="size-14" />}>
              Save as…
            </Button>
          </MenuTrigger>
          <MenuContent align="end" aria-label={`Save ${diagram.title} as`}>
            <MenuItem onSelect={() => save('png')}>PNG image</MenuItem>
            <MenuItem onSelect={() => save('svg')}>SVG image</MenuItem>
          </MenuContent>
        </Menu>
        <RD.Close asChild>
          <IconButton label="Close" tooltip={false}>
            <X className="size-14" />
          </IconButton>
        </RD.Close>
      </header>
      <div ref={area} className="min-h-0 flex-1 overflow-auto bg-sunken">
        {address.status === 'error' ? (
          <p role="alert" className="flex h-full items-center justify-center px-24 text-center text-base text-fg-muted">
            {address.message}
          </p>
        ) : url ? (
          // Auto margins centre the page while it fits and let it scroll from its own corner once it doesn't.
          <div className="flex min-h-full min-w-full p-16" style={{ width: 'max-content' }}>
            <div className={size ? 'm-auto opacity-100 transition-opacity duration-[var(--g-duration-base)]' : 'm-auto opacity-0'}>
              <ScaledFrame frameRef={frame} url={url} title={diagram.title} width={width} height={height} scale={scale} interactive />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A diagram, large: the page itself in a frame that takes clicks (so a
 * diagram's own step controls work), with zoom and the copies. Open while
 * `diagram` is given.
 */
export function DiagramViewer({ sessionId, diagram, onClose }: { sessionId: string; diagram: MadeDiagram | null; onClose: () => void }) {
  // The one last shown stays while the dialog leaves, so it does not empty before it has gone.
  const [last, setLast] = useState(diagram);
  if (diagram && diagram !== last) setLast(diagram);
  const shown = diagram ?? last;
  return (
    <RD.Root open={diagram !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <RD.Portal>
        <RD.Overlay className="overlay-scrim fixed inset-0 z-[var(--g-z-dialog)] bg-overlay" />
        <RD.Content
          aria-describedby={undefined}
          className="overlay-dialog fixed top-1/2 left-1/2 z-[var(--g-z-dialog)] flex h-[88vh] w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-surface text-fg shadow-popover outline-none"
        >
          {shown ? <ViewerBody key={`${sessionId}:${shown.name}:${shown.title}`} sessionId={sessionId} diagram={shown} /> : null}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
