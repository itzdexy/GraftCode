import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { ViewHeader } from './ViewHeader';

interface PageLayoutProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Wide pages (two-pane editors) use the full main width. */
  wide?: boolean;
}

/** Shared frame for the Projects, Artifacts, Scheduled, Customize and Settings views. */
export function PageLayout({ title, description, actions, children, wide = false }: PageLayoutProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn('mx-auto flex w-full flex-col px-24 pt-8 pb-32', wide ? 'max-w-[1100px]' : 'max-w-[calc(var(--g-content-width)+48px)]')}>
          <header className="flex items-start gap-12">
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-medium text-fg-strong">{title}</h1>
              {description ? <div className="mt-4 text-base text-fg-muted">{description}</div> : null}
            </div>
            {actions ? <div className="flex shrink-0 items-center gap-6">{actions}</div> : null}
          </header>
          <div className="mt-20">{children}</div>
        </div>
      </div>
    </div>
  );
}
