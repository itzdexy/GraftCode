import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

/** Mirrors --g-sidebar-min-width / --g-sidebar-max-width / --g-sidebar-width in tokens.css. */
export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_DEFAULT = 262;
const KEY_STEP = 8;

export function clampSidebar(width: number): number {
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));
}

interface SidebarResizerProps {
  width: number;
  /** Live width while dragging (not persisted). */
  onPreview: (width: number | null) => void;
  /** Final width to persist. */
  onCommit: (width: number) => void;
}

/** Drag handle on the sidebar's right edge; arrow keys resize, double-click resets. */
export function SidebarResizer({ width, onPreview, onCommit }: SidebarResizerProps) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; last: number } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, last: width };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    d.last = clampSidebar(d.startWidth + event.clientX - d.startX);
    onPreview(d.last);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    drag.current = null;
    onPreview(null);
    if (d.last !== d.startWidth) onCommit(d.last);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const delta = event.key === 'ArrowLeft' ? -KEY_STEP : event.key === 'ArrowRight' ? KEY_STEP : 0;
    if (delta !== 0) {
      event.preventDefault();
      onCommit(clampSidebar(width + delta));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      onCommit(event.key === 'Home' ? SIDEBAR_MIN : SIDEBAR_MAX);
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onCommit(SIDEBAR_DEFAULT)}
      onKeyDown={onKeyDown}
      className="absolute top-0 -right-3 z-[var(--g-z-sticky)] h-full w-6 cursor-col-resize outline-none focus-visible:bg-focus/40"
    />
  );
}
