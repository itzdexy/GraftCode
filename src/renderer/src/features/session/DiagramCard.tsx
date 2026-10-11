import { Download, ExternalLink, FolderOpen, ImageDown, Maximize2, MoreHorizontal, Workflow } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { Button, IconButton } from '../../components/Button';
import { Spinner } from '../../components/ContextRing';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../components/Menu';
import { cn } from '../../lib/cn';
import { useFileActions } from '../panels/FileMenu';
import { ScaledFrame, useDiagramAddress, useDiagramCopies, usePageSize } from './DiagramFrame';
import { DiagramViewer } from './DiagramViewer';
import { CARD_MAX_HEIGHT, CARD_MAX_SHOWN, fitScale, frameWidth, sourceKey, type MadeDiagram } from './diagramModel';

/** The width a card is taken to have until it has been measured: the transcript's column. */
const ASSUMED_WIDTH = 700;

/** One diagram of a turn: the page itself, scaled to the card, with its name and what can be done with it. */
function DiagramRow({ sessionId, diagram, onOpen }: { sessionId: string; diagram: MadeDiagram; onOpen: () => void }) {
  const address = useDiagramAddress(sessionId, diagram.source);
  const url = address.status === 'ready' ? address.url : null;
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  const size = usePageSize(frame, url);
  const { busy, copy, save } = useDiagramCopies(sessionId, diagram);
  const run = useFileActions(sessionId);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = (): void => setBoxWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const available = boxWidth > 0 ? boxWidth : ASSUMED_WIDTH;
  const width = frameWidth(diagram.width);
  // Until the page has said how tall it is, it is laid out unseen in a short frame, so what it reports is its own height.
  const height = size?.height ?? 100;
  const scale = fitScale({ width, height }, { width: available, maxHeight: CARD_MAX_HEIGHT });
  // The place held before that: the diagram's own shape, as wide as the card allows.
  const held = Math.min(CARD_MAX_HEIGHT, Math.round((available * diagram.height) / diagram.width));
  const path = diagram.source.kind === 'project' ? diagram.source.path : diagram.source.name;
  const target = { path, type: 'file' as const };

  return (
    <li aria-label={diagram.title} className="flex flex-col border-t border-border-subtle first:border-t-0">
      <div ref={box} className="relative flex items-center justify-center overflow-hidden bg-sunken" style={size ? undefined : { minHeight: held }}>
        {address.status === 'error' ? (
          <p className="px-16 py-12 text-center text-md text-fg-muted">{address.message}</p>
        ) : url ? (
          <>
            <div className={cn(size ? 'opacity-100 transition-opacity duration-[var(--g-duration-base)]' : 'absolute opacity-0')}>
              <ScaledFrame frameRef={frame} url={url} title={diagram.title} width={width} height={height} scale={scale} interactive={false} />
            </div>
            <button
              type="button"
              aria-label={`Open ${diagram.title}`}
              onClick={onOpen}
              // The ring is drawn inside the button's edge: the box around it clips what lies outside.
              className="absolute inset-0 cursor-zoom-in -outline-offset-2"
            />
          </>
        ) : null}
      </div>
      <div className="flex min-h-36 flex-wrap items-center gap-x-4 gap-y-4 px-12 py-6">
        <div className="min-w-[120px] flex-1">
          <p className="truncate text-md font-medium text-fg-strong">{diagram.title}</p>
          <p className="selectable truncate font-mono text-2xs text-fg-muted" title={path}>
            {path}
          </p>
        </div>
        <Button size="sm" variant="ghost" disabled={url === null} leading={<Maximize2 className="size-12" />} onClick={onOpen}>
          Open
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={url === null || busy !== null}
          leading={busy === 'copy' ? <Spinner size={12} label="Copying" /> : <ImageDown className="size-12" />}
          onClick={copy}
        >
          Copy image
        </Button>
        <Menu>
          <MenuTrigger asChild>
            <Button size="sm" variant="ghost" disabled={url === null || busy !== null} leading={busy === 'save' ? <Spinner size={12} label="Saving" /> : <Download className="size-12" />}>
              Save as…
            </Button>
          </MenuTrigger>
          <MenuContent align="end" aria-label={`Save ${diagram.title} as`}>
            <MenuItem onSelect={() => save('png')}>PNG image</MenuItem>
            <MenuItem onSelect={() => save('svg')}>SVG image</MenuItem>
          </MenuContent>
        </Menu>
        {diagram.source.kind === 'project' ? (
          <Menu>
            <MenuTrigger asChild>
              <IconButton label={`More for ${diagram.name}`} size="sm">
                <MoreHorizontal className="size-14" />
              </IconButton>
            </MenuTrigger>
            <MenuContent align="end" aria-label={`More for ${diagram.name}`}>
              <MenuItem icon={<ExternalLink className="size-14" />} onSelect={() => run('open', target)}>
                Open in browser
              </MenuItem>
              <MenuItem icon={<FolderOpen className="size-14" />} onSelect={() => run('reveal', target)}>
                Show in folder
              </MenuItem>
            </MenuContent>
          </Menu>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The diagrams a turn drew, each shown as it is: the page the agent wrote,
 * live in a frame that can't reach anything, scaled to fit. A click opens it
 * large.
 */
export function DiagramCard({ sessionId, diagrams }: { sessionId: string; diagrams: MadeDiagram[] }) {
  const [all, setAll] = useState(false);
  const [viewing, setViewing] = useState<MadeDiagram | null>(null);
  const shown = all ? diagrams : diagrams.slice(0, CARD_MAX_SHOWN);
  return (
    <section aria-label="Diagrams from this turn" className="overflow-hidden rounded-md border border-border-card">
      <header className="flex h-30 items-center gap-8 border-b border-border-subtle px-12 text-md">
        <Workflow className="size-13 shrink-0 text-icon" aria-hidden="true" />
        <span className="flex-1 font-medium text-fg-strong">{diagrams.length === 1 ? '1 diagram' : `${String(diagrams.length)} diagrams`}</span>
      </header>
      <ul className="flex flex-col">
        {shown.map((diagram) => (
          <DiagramRow key={sourceKey(diagram.source)} sessionId={sessionId} diagram={diagram} onOpen={() => setViewing(diagram)} />
        ))}
      </ul>
      {diagrams.length > shown.length ? (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="flex h-26 w-full items-center gap-6 border-t border-border-subtle px-12 text-left text-md text-fg-muted transition-ui hover:bg-hover hover:text-fg-secondary"
        >
          Show {String(diagrams.length - shown.length)} more
        </button>
      ) : null}
      <DiagramViewer sessionId={sessionId} diagram={viewing} onClose={() => setViewing(null)} />
    </section>
  );
}
