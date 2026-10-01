import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton } from '../../components/Button';
import { cn } from '../../lib/cn';

interface PanelFrameProps {
  title: ReactNode;
  /** Controls between the title and the close button. */
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  label: string;
}

/** Docked side panel: 36px header (title, actions, close) over a flexible body. */
export function PanelFrame({ title, actions, onClose, children, className, label }: PanelFrameProps) {
  return (
    <section aria-label={label} className={cn('flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border-panel bg-sunken', className)}>
      <header className="flex h-36 shrink-0 items-center gap-6 border-b border-border-panel pr-4 pl-10">
        <div className="flex min-w-0 flex-1 items-center gap-6 text-base text-fg-tertiary">{title}</div>
        {actions}
        <IconButton label={`Close ${label}`} size="xs" onClick={onClose}>
          <X className="size-14" />
        </IconButton>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  );
}
