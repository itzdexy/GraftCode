import { TriangleAlert } from 'lucide-react';
import type { SessionSummary } from '@shared/schemas/sessions';
import { Ring } from '../../components/ContextRing';
import { cn } from '../../lib/cn';

export function statusText(s: SessionSummary): string {
  if (s.status === 'needs-input') return 'Needs input';
  if (s.status === 'error') return 'Error';
  if (s.status === 'running') return 'Running';
  if (s.unread) return 'Finished';
  return 'Idle';
}

/**
 * Sidebar bullet: hollow dot idle, amber dot needs input or finished unseen,
 * spinning ring while running, red triangle on error.
 */
export function SessionStatusIcon({ session, className }: { session: SessionSummary; className?: string }) {
  const label = statusText(session);
  if (session.status === 'error') {
    return <TriangleAlert className={cn('size-12 shrink-0 text-danger', className)} aria-label={label} role="img" />;
  }
  if (session.status === 'running') {
    return (
      <span className={cn('inline-flex size-12 shrink-0 items-center justify-center', className)}>
        <Ring value={0} size={10} stroke={1.5} spinning label={label} />
      </span>
    );
  }
  const filled = session.status === 'needs-input' || session.unread;
  return (
    <span className={cn('inline-flex size-12 shrink-0 items-center justify-center', className)} role="img" aria-label={label}>
      <span
        className={cn(
          'block size-[var(--g-bullet-size)] rounded-full',
          filled ? 'bg-amber' : 'border border-fg-muted'
        )}
      />
    </span>
  );
}
