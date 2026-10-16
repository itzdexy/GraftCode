import { useEffect, useState, type RefObject } from 'react';
import type { DiagramSource } from '@shared/schemas/diagrams';
import { invoke } from '../../lib/ipc';
import { useLoad } from '../../lib/useLoad';
import { reportError, useToasts } from '../../stores/toasts';
import { MAX_SIZE_REPORTS, previewProblem, sizeFromMessage, sourceKey, type MadeDiagram } from './diagramModel';

/**
 * What the card and the viewer of a diagram share: the address its page is
 * shown at, the size the page says it has, the frame itself, and the copies.
 */

export type DiagramAddress = { status: 'loading' } | { status: 'ready'; url: string } | { status: 'error'; message: string };

/** The address a diagram is shown at: asked for when the diagram is first drawn, with the sentence to show when it can't be. */
export function useDiagramAddress(sessionId: string, source: DiagramSource): DiagramAddress {
  const { load } = useLoad(
    () =>
      invoke('diagrams:previewUrl', { sessionId, source }).catch((error: unknown) => {
        throw new Error(previewProblem(error));
      }),
    `${sessionId}:${sourceKey(source)}`
  );
  if (load.status === 'ready') return { status: 'ready', url: load.data.url };
  return load;
}

/**
 * The size a diagram's page reports for itself (see SIZE_REPORTER in the
 * main process); null until it has. A message counts only when it comes from
 * this frame and holds a size, and a page gets to change its mind a few
 * times, not for ever.
 */
export function usePageSize(frame: RefObject<HTMLIFrameElement>, url: string | null): { width: number; height: number } | null {
  const [size, setSize] = useState<{ url: string; width: number; height: number } | null>(null);
  useEffect(() => {
    if (url === null) return;
    let changes = 0;
    let last: { width: number; height: number } | null = null;
    const onMessage = (event: MessageEvent): void => {
      if (event.source === null || event.source !== frame.current?.contentWindow) return;
      const reported = sizeFromMessage(event.data);
      if (!reported || (last && last.width === reported.width && last.height === reported.height) || changes >= MAX_SIZE_REPORTS) return;
      changes++;
      last = reported;
      setSize({ url, ...reported });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frame, url]);
  return size && size.url === url ? { width: size.width, height: size.height } : null;
}

/**
 * A diagram's page in a frame of the page's own size, drawn smaller or larger
 * by `scale`. The page is something a model wrote: the frame has scripts and
 * nothing else (no network, no forms, no way out; see ARTIFACT_CSP), and in
 * a card it takes no clicks and no focus.
 */
export function ScaledFrame({
  frameRef,
  url,
  title,
  width,
  height,
  scale,
  interactive
}: {
  frameRef: RefObject<HTMLIFrameElement>;
  url: string;
  title: string;
  width: number;
  height: number;
  scale: number;
  interactive: boolean;
}) {
  return (
    <div className="shrink-0 overflow-hidden" style={{ width: Math.round(width * scale), height: Math.round(height * scale) }}>
      <iframe
        ref={frameRef}
        title={`Diagram: ${title}`}
        src={url}
        sandbox="allow-scripts"
        loading="lazy"
        tabIndex={interactive ? 0 : -1}
        className="block border-0 bg-white"
        style={{ width, height, transform: `scale(${String(scale)})`, transformOrigin: '0 0', pointerEvents: interactive ? 'auto' : 'none' }}
      />
    </div>
  );
}

function lastPart(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

/** Copying a picture of a diagram and saving it as PNG or SVG; `busy` names the one under way, which takes a moment to draw. */
export function useDiagramCopies(sessionId: string, diagram: MadeDiagram): { busy: 'copy' | 'save' | null; copy: () => void; save: (format: 'png' | 'svg') => void } {
  const [busy, setBusy] = useState<'copy' | 'save' | null>(null);
  const copy = (): void => {
    setBusy('copy');
    invoke('diagrams:copyImage', { sessionId, source: diagram.source })
      .then(
        () => useToasts.getState().push({ tone: 'success', title: 'Copied the diagram' }),
        (error: unknown) => reportError(`Couldn't copy ${diagram.name}`, error)
      )
      .finally(() => setBusy(null));
  };
  const save = (format: 'png' | 'svg'): void => {
    setBusy('save');
    invoke('diagrams:save', { sessionId, source: diagram.source, format })
      .then(
        ({ path }) => {
          if (path !== null) useToasts.getState().push({ tone: 'success', title: `Saved ${lastPart(path)}`, description: path });
        },
        (error: unknown) => reportError(`Couldn't save ${diagram.name}`, error)
      )
      .finally(() => setBusy(null));
  };
  return { busy, copy, save };
}
