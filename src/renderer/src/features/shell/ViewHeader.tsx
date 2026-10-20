import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { useApp } from '../../stores/app';
import { TitlebarControls } from './TitlebarControls';

interface ViewHeaderProps {
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** False when this header is not at the window's left edge: nothing of the window is there to keep clear of. */
  atLeftEdge?: boolean;
  /** False when this header is not at the window's right edge: the native controls are elsewhere. */
  atRightEdge?: boolean;
}

/**
 * The titlebar row above a view: draggable, holds the view's own controls
 * (left) and actions (right), and keeps clear of the native window controls.
 * With the sidebar hidden it also carries the navigation controls.
 *
 * The row is a container, so what does not fit in a narrow pane (a split view)
 * can step aside, and the controls are clipped rather than drawn over the
 * buttons on the right. Only the pane at the window's edge keeps clear of the
 * native controls: in a split view they are over the pane beside the open one.
 */
export function ViewHeader({ children, actions, className, atLeftEdge = true, atRightEdge = true }: ViewHeaderProps) {
  const collapsed = useApp((s) => s.settings?.ui.sidebarCollapsed ?? false);
  return (
    <header
      className={cn(
        '@container app-drag flex h-[var(--g-titlebar-height)] shrink-0 items-center gap-8',
        atRightEdge ? 'pr-[calc(var(--g-controls-right)+8px)]' : 'pr-8',
        atLeftEdge && collapsed ? 'pl-[calc(var(--g-controls-left)+8px)]' : 'pl-16',
        className
      )}
    >
      {collapsed && atLeftEdge ? <TitlebarControls className="mr-8 w-[196px] shrink-0" /> : null}
      <div className="@container flex min-w-0 flex-1 items-center gap-8 overflow-hidden">{children}</div>
      {actions ? <div className="flex shrink-0 items-center gap-4">{actions}</div> : null}
    </header>
  );
}
