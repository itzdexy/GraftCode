import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';

type BadgeTone = 'neutral' | 'warning' | 'counter' | 'accent' | 'danger';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-badge text-fg-tertiary',
  warning: 'bg-warning-bg text-warning-fg',
  counter: 'bg-counter-bg text-counter-fg',
  accent: 'bg-accent-dim text-accent-strong',
  danger: 'bg-danger-bg text-danger'
};

/** Small inline label, e.g. "Recommended" (15px tall in the references). */
export function Badge({
  tone = 'neutral',
  icon,
  children,
  className
}: {
  tone?: BadgeTone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-16 shrink-0 items-center gap-4 rounded-xs px-6 text-2xs font-medium whitespace-nowrap',
        TONES[tone],
        className
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/** Outlined key hint, e.g. the 1–9 option keys. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-16 min-w-16 items-center justify-center rounded-xs border border-key-border px-3 font-sans text-2xs text-fg-muted',
        className
      )}
    >
      {children}
    </kbd>
  );
}

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
}

/** Context chip (environment, folder, branch). 22px tall, control surface. */
export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { icon, children, className, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex h-22 max-w-[240px] shrink-0 items-center gap-6 rounded-sm border border-chip-edge bg-control px-6 text-base text-fg-secondary transition-ui hover:text-fg disabled:text-fg-faint',
        className
      )}
      {...rest}
    >
      {icon}
      {children !== undefined ? <span className="truncate">{children}</span> : null}
    </button>
  );
});
