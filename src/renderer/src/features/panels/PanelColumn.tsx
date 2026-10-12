import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { LoadingState } from '../../components/States';
import { lastShown, SLIDE_EXIT_MS, usePresence } from '../../lib/motion';
import { useApp } from '../../stores/app';
import { panelsOf, PANEL_MIN_WIDTH, usePanels, type PanelId } from '../../stores/panels';
import { AgentsPanel } from './AgentsPanel';
import { BrowserPanelView } from './BrowserPanel';
import { ChangesPanel } from './ChangesPanel';
import { TasksPanel } from './TasksPanel';

// The terminal brings xterm.js, so it loads the first time a terminal opens.
const TerminalPanel = lazy(() => import('./TerminalPanel').then((m) => ({ default: m.TerminalPanel })));

/** Leave at least this much room for the transcript next to the panels. */
const TRANSCRIPT_MIN = 420;

/**
 * Right-hand column of docked panels for a code session, resizable from its left edge. The column slides open when
 * the first panel opens and shut when the last one closes, so the transcript moves aside instead of jumping. Only
 * the column's track changes: the panels keep their width the whole time, so a terminal is not refitted on every
 * frame, and they stay in the column while it slides shut.
 */
export function PanelColumn({ sessionId, refreshKey }: { sessionId: string; refreshKey: unknown }) {
  const open = usePanels((s) => panelsOf(s, sessionId).open);
  const storedWidth = usePanels((s) => s.width);
  const wide = usePanels((s) => s.wide);
  const close = usePanels((s) => s.close);
  const sidebar = useApp((s) => (s.settings?.ui.sidebarCollapsed ? 0 : (s.settings?.ui.sidebarWidth ?? 262)));
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const [preview, setPreview] = useState<number | null>(null);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; last: number } | null>(null);

  useEffect(() => {
    const onResize = (): void => setViewport(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // What the column held last is drawn until it has slid shut.
  const [held, setHeld] = useState(open);
  if (open.length > 0 && open !== held) setHeld(open);
  const present = usePresence(open.length > 0, SLIDE_EXIT_MS);
  const limit = Math.max(PANEL_MIN_WIDTH, viewport - sidebar - TRANSCRIPT_MIN);
  const width = Math.min(limit, preview ?? (wide ? limit : storedWidth));
  const clamp = (w: number): number => Math.round(Math.min(limit, Math.max(PANEL_MIN_WIDTH, w)));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, last: width };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    d.last = clamp(d.startWidth - (event.clientX - d.startX));
    setPreview(d.last);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    drag.current = null;
    setPreview(null);
    usePanels.getState().setWidth(d.last);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const delta = event.key === 'ArrowLeft' ? 16 : event.key === 'ArrowRight' ? -16 : 0;
    if (delta === 0) return;
    event.preventDefault();
    usePanels.getState().setWidth(clamp(width + delta));
  };

  const render = (id: PanelId): JSX.Element => {
    const onClose = (): void => close(sessionId, id);
    switch (id) {
      case 'terminal':
        return (
          <Suspense key={id} fallback={<LoadingState label="Starting the terminal" />}>
            <TerminalPanel sessionId={sessionId} onClose={onClose} />
          </Suspense>
        );
      case 'changes':
        return <ChangesPanel key={id} sessionId={sessionId} refreshKey={refreshKey} onClose={onClose} />;
      case 'browser':
        return <BrowserPanelView key={id} sessionId={sessionId} onClose={onClose} />;
      case 'tasks':
        return <TasksPanel key={id} sessionId={sessionId} wide={wide} onToggleWide={() => usePanels.getState().toggleWide()} onClose={onClose} />;
      case 'agents':
        return <AgentsPanel key={id} sessionId={sessionId} wide={wide} onToggleWide={() => usePanels.getState().toggleWide()} onClose={onClose} />;
    }
  };

  return (
    <div className="graft-slide-x graft-slide-x--flush h-full shrink-0" data-state={open.length > 0 ? 'open' : 'closed'}>
      {/* The column can only narrow around something without a width of its own; the panels keep theirs inside. */}
      <div>
        {present ? (
          <aside aria-label="Panels" className="relative flex h-full shrink-0 flex-col gap-8 py-8 pr-8" style={{ width }}>
            {/* Inside the column's edge and not across it: the column is cut exactly at its edge while it slides. */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize panels"
              aria-valuenow={width}
              aria-valuemin={PANEL_MIN_WIDTH}
              aria-valuemax={limit}
              tabIndex={0}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onKeyDown={onKeyDown}
              className="absolute top-0 left-0 z-[var(--g-z-sticky)] h-full w-6 cursor-col-resize outline-none focus-visible:bg-focus/40"
            />
            {lastShown(open, held).map(render)}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
