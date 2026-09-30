import * as RS from '@radix-ui/react-slider';
import { cn } from '../lib/cn';

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  label: string;
  /** Screen-reader text for the current value, e.g. "150%". */
  valueText?: string;
  className?: string;
}

/** Plain continuous slider (e.g. avatar zoom). */
export function Slider({ value, min, max, step, onChange, label, valueText, className }: SliderProps) {
  return (
    <RS.Root
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={(v) => {
        const next = v[0];
        if (next !== undefined) onChange(next);
      }}
      className={cn('relative flex h-16 w-full touch-none items-center select-none', className)}
    >
      <RS.Track className="relative h-4 grow overflow-hidden rounded-full bg-control">
        <RS.Range className="absolute h-full rounded-full bg-fg-muted" />
      </RS.Track>
      <RS.Thumb
        aria-label={label}
        aria-valuetext={valueText}
        className="block size-14 rounded-full border border-border-strong bg-fg-strong shadow-composer transition-ui"
      />
    </RS.Root>
  );
}
