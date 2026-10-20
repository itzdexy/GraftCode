import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { SIDE_MIN, usePanes } from '../../stores/panes';
import { useSessions } from '../../stores/sessions';
import { SessionView } from '../session/SessionView';

/** The drag handle between the two sessions; arrow keys resize, double-click resets. */
function SplitResizer({ width }: { width: number }) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; last: number } | null>(null);
  const clamp = (value: number): number => Math.round(Math.min(Math.max(SIDE_MIN, value), Math.max(SIDE_MIN, window.innerWidth - SIDE_MIN)));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, last: width };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    // Dragging left makes the side session wider.
    d.last = clamp(d.startWidth + (d.startX - event.clientX));
    usePanes.getState().setWidth(d.last);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const delta = event.key === 'ArrowLeft' ? 16 : event.key === 'ArrowRight' ? -16 : 0;
    if (delta !== 0) {
      event.preventDefault();
      usePanes.getState().setWidth(clamp(width + delta));
    } else if (event.key === 'Home') {
      event.preventDefault();
      usePanes.getState().setWidth(SIDE_MIN);
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the side session"
      aria-valuemin={SIDE_MIN}
      aria-valuemax={Math.max(SIDE_MIN, window.innerWidth - SIDE_MIN)}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => usePanes.getState().setWidth(SIDE_MIN + 200)}
      onKeyDown={onKeyDown}
      className="group relative w-4 shrink-0 cursor-col-resize outline-none"
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border-subtle transition-ui group-hover:bg-border-strong group-focus-visible:bg-focus" aria-hidden="true" />
    </div>
  );
}

/**
 * The open session, and a second one beside it when the user opened one. The two are
 * ordinary session views: each keeps its own transcript, panels and composer. The pane
 * the keyboard belongs to is underlined by its own focus ring on click; window shortcuts
 * (Ctrl+F, F3, Ctrl+`, Esc) act on the focused pane only.
 */
export function SessionSplit({ id }: { id: string }) {
  const side = usePanes((s) => s.side);
  const width = usePanes((s) => s.width);
  const sideExists = useSessions((s) => (side === null ? false : s.summaries[side] !== undefined));

  // A side session that is deleted — or that became the open one — leaves the split quietly.
  useEffect(() => {
    if (side !== null && (side === id || !sideExists)) usePanes.getState().close();
  }, [side, id, sideExists]);

  if (side === null || side === id || !sideExists) return <SessionView key={id} sessionId={id} />;
  return (
    <div className="flex h-full min-h-0">
      <div
        role="group"
        aria-label="Open session"
        className="min-w-0 flex-1"
        onPointerDownCapture={() => usePanes.getState().setFocus('main')}
        onFocusCapture={() => usePanes.getState().setFocus('main')}
      >
        <SessionView key={id} sessionId={id} />
      </div>
      <SplitResizer width={width} />
      <div
        role="group"
        aria-label="Session beside"
        className="min-w-0 shrink-0"
        style={{ width }}
        onPointerDownCapture={() => usePanes.getState().setFocus('side')}
        onFocusCapture={() => usePanes.getState().setFocus('side')}
      >
        <SessionView key={side} sessionId={side} pane="side" onClose={() => usePanes.getState().close()} />
      </div>
    </div>
  );
}
