import type { ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from './Button';
import { Spinner } from './ContextRing';

export function LoadingState({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={cn('motion-rise flex items-center justify-center gap-8 py-24 text-base text-fg-muted', className)}>
      <Spinner label={label} />
      <span>{label}</span>
    </div>
  );
}

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('motion-rise flex flex-col items-center justify-center gap-6 px-24 py-32 text-center', className)}>
      {icon ? <div className="mb-4 text-icon-muted">{icon}</div> : null}
      <p className="text-base font-medium text-fg-secondary">{title}</p>
      {description ? <p className="max-w-[360px] text-sm text-fg-muted">{description}</p> : null}
      {action ? <div className="mt-8">{action}</div> : null}
    </div>
  );
}

interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({ title = 'Something went wrong', message, onRetry, className }: ErrorStateProps) {
  return (
    <div role="alert" className={cn('motion-rise flex flex-col items-center justify-center gap-6 px-24 py-32 text-center', className)}>
      <TriangleAlert className="mb-4 size-20 text-danger" aria-hidden="true" />
      <p className="text-base font-medium text-fg-secondary">{title}</p>
      <p className="selectable max-w-[420px] text-sm break-words text-fg-muted">{message}</p>
      {onRetry ? (
        <Button size="sm" className="mt-8" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
