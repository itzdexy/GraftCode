import { cn } from '../lib/cn';

/** "Graft" set in the serif at display weight. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('font-serif font-semibold tracking-[-0.01em] text-fg-strong', className)}>Graft</span>
  );
}
