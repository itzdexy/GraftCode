import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { useApp } from '../../stores/app';
import { TitlebarControls } from './TitlebarControls';

interface ViewHeaderProps {
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/**
 * The titlebar row above a view: draggable, holds the view's own controls
 * (left) and actions (right), and keeps clear of the native window controls.
 * With the sidebar hidden it also carries the navigation controls.
 */
export function ViewHeader({ children, actions, className }: ViewHeaderProps) {
  const collapsed = useApp((s) => s.settings?.ui.sidebarCollapsed ?? false);
  return (
    <header
      className={cn(
        'app-drag flex h-[var(--g-titlebar-height)] shrink-0 items-center gap-8 pr-[calc(var(--g-controls-right)+8px)]',
        collapsed ? 'pl-[calc(var(--g-controls-left)+8px)]' : 'pl-16',
        className
      )}
    >
      {collapsed ? <TitlebarControls className="mr-8 w-[196px] shrink-0" /> : null}
      <div className="flex min-w-0 flex-1 items-center gap-8">{children}</div>
      {actions ? <div className="flex shrink-0 items-center gap-4">{actions}</div> : null}
    </header>
  );
}
