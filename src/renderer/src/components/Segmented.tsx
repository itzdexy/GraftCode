import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { Tooltip } from './Tooltip';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  /** Small notification dot on the segment (amber). */
  dot?: boolean;
}

interface SegmentedProps<T extends string> {
  value: T;
  options: ReadonlyArray<SegmentOption<T>>;
  onChange: (value: T) => void;
  /** "titlebar": 25px icon toggle (Chat|Code). "composer": 26px text toggle. */
  variant: 'titlebar' | 'composer';
  label: string;
  className?: string;
}

/** Radio-group semantics with roving focus (arrow keys). */
export function Segmented<T extends string>({ value, options, onChange, variant, label, className }: SegmentedProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = (index + delta + options.length) % options.length;
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    refs.current[next]?.focus();
  };

  const titlebar = variant === 'titlebar';
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        'relative inline-flex items-center p-1',
        titlebar ? 'h-[var(--g-segment-height)] rounded-sm bg-segment-track' : 'h-[var(--g-composer-toggle-height)] rounded-md bg-toggle-track',
        className
      )}
    >
      {/* The titlebar's segments are all one width, so one thumb slides between them instead of jumping. */}
      {titlebar ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1 bottom-1 left-1 w-31 rounded-[5px] border border-segment-thumb-border bg-segment-thumb transition-[translate] duration-[var(--g-duration-spring)] ease-[var(--g-ease-spring)]"
          style={{ translate: `${String(index * 31)}px 0` }}
        />
      ) : null}
      {options.map((option, i) => {
        const selected = option.value === value;
        const button = (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.icon && titlebar ? option.label : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              'relative inline-flex h-full items-center justify-center border transition-ui',
              titlebar ? 'w-31 rounded-[5px]' : 'rounded-[7px] px-8 text-base',
              selected
                ? titlebar
                  ? 'border-transparent text-fg-strong'
                  : 'border-toggle-thumb-border bg-toggle-thumb text-fg-strong'
                : 'border-transparent text-fg-muted hover:text-fg-secondary'
            )}
          >
            {titlebar && option.icon ? option.icon : option.label}
            {option.dot ? (
              <span className="absolute top-3 right-7 size-6 rounded-full bg-amber" aria-hidden="true" />
            ) : null}
          </button>
        );
        return titlebar ? (
          <Tooltip key={option.value} content={option.label}>
            {button}
          </Tooltip>
        ) : (
          button
        );
      })}
    </div>
  );
}
