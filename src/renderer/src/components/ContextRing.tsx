import { cn } from '../lib/cn';

interface RingProps {
  /** 0..1 fill; ignored while `spinning`. */
  value: number;
  size?: number;
  stroke?: number;
  spinning?: boolean;
  className?: string;
  /** Accessible label; decorative when omitted. */
  label?: string;
}

/** Circular usage ring (12px, blue arc on the control-surface track). */
export function Ring({ value, size = 12, stroke = 1.5, spinning = false, className, label }: RingProps) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.min(1, Math.max(0, value));
  const dash = spinning ? c * 0.3 : c * clamped;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn('shrink-0', spinning && 'animate-[graft-spin_900ms_linear_infinite]', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--g-surface-control)" strokeWidth={stroke} />
      {dash > 0 ? (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--g-blue)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      ) : null}
    </svg>
  );
}

/** Indeterminate loading indicator built on the ring. */
export function Spinner({ size = 14, label = 'Loading' }: { size?: number; label?: string }) {
  return <Ring value={0} size={size} stroke={1.75} spinning label={label} />;
}
