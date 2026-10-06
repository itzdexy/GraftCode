import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Tooltip } from './Tooltip';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type Size = 'xs' | 'sm' | 'md';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-btn-primary text-btn-primary-fg hover:bg-btn-primary-hover disabled:bg-btn-primary-disabled disabled:text-btn-primary-disabled-fg',
  secondary: 'bg-btn-secondary text-fg hover:bg-btn-secondary-hover disabled:text-fg-muted',
  ghost: 'bg-transparent text-fg-secondary hover:bg-hover hover:text-fg disabled:text-fg-faint',
  outline: 'bg-transparent text-fg border border-border hover:bg-hover disabled:text-fg-faint',
  danger: 'bg-danger text-bg hover:opacity-90 disabled:opacity-50'
};

const SIZES: Record<Size, string> = {
  xs: 'h-20 px-6 text-xs rounded-xs gap-4',
  sm: 'h-22 px-8 text-sm rounded-sm gap-4',
  md: 'h-28 px-12 text-base rounded-md gap-6'
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  leading?: ReactNode;
  trailing?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', leading, trailing, className, children, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'pressable inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-ui disabled:pointer-events-none',
        VARIANTS[variant],
        SIZES[size],
        className
      )}
      {...rest}
    >
      {leading}
      {children}
      {trailing}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name; also shown as the tooltip unless `tooltip` is false. */
  label: string;
  tooltip?: boolean;
  shortcut?: string;
  size?: 'xs' | 'sm' | 'md';
  active?: boolean;
}

const ICON_SIZES = { xs: 'size-20 rounded-xs', sm: 'size-24 rounded-sm', md: 'size-28 rounded-md' } as const;

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, tooltip = true, shortcut, size = 'sm', active = false, className, children, type = 'button', ...rest },
  ref
) {
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cn(
        'pressable inline-flex shrink-0 items-center justify-center text-icon transition-ui hover:bg-hover hover:text-icon-strong disabled:text-fg-faint disabled:hover:bg-transparent',
        active && 'bg-hover text-icon-strong',
        ICON_SIZES[size],
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
  if (!tooltip) return button;
  return (
    <Tooltip content={label} shortcut={shortcut}>
      {button}
    </Tooltip>
  );
});
