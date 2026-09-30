import * as RS from '@radix-ui/react-slider';
import { CircleQuestionMark } from 'lucide-react';
import type { EffortLevel } from '@shared/schemas/common';
import type { ModelInfo } from '@shared/schemas/models';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/Popover';
import { Tooltip } from '../../components/Tooltip';
import { cn } from '../../lib/cn';
import { EFFORT_LABELS } from '../../lib/format';

export const EFFORT_HELP =
  'Higher effort thinks longer and checks its work more, but is slower and uses more tokens. Taproot is a long-horizon mode: larger budgets, and it keeps going until the work is verified.';

/** Thumb width (--g-effort-knob-width); ticks are laid out on the thumb-center path. */
const KNOB = 16;

function tickLeft(index: number, count: number): string {
  const f = count <= 1 ? 0 : index / (count - 1);
  return `calc(${KNOB / 2}px + (100% - ${KNOB}px) * ${f})`;
}

interface EffortPopoverProps {
  model: ModelInfo;
  value: EffortLevel;
  onChange: (level: EffortLevel) => void;
  disabled?: boolean;
}

/** Code-mode effort control: a stepped slider from Faster to Smarter with the recommended tick marked. */
export function EffortPopover({ model, value, onChange, disabled = false }: EffortPopoverProps) {
  const levels = model.effort?.levels ?? [];
  if (levels.length === 0) return null;
  const index = Math.max(0, levels.indexOf(value));
  const recommended = model.effort ? levels.indexOf(model.effort.recommended) : -1;
  const taproot = value === 'taproot';

  return (
    <Popover>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={`Effort: ${EFFORT_LABELS[value]}`}
          className={cn(
            'inline-flex h-22 items-center rounded-md px-6 text-base transition-ui hover:bg-hover data-[state=open]:bg-hover disabled:text-fg-faint',
            taproot ? 'font-medium text-accent' : 'text-fg-muted hover:text-fg-secondary'
          )}
        >
          {EFFORT_LABELS[value]}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[212px] px-12 pt-10 pb-12">
        <div className="flex items-center gap-6">
          <span className="text-md text-fg-muted">Effort</span>
          <span className={cn('text-md font-semibold', taproot ? 'text-accent' : 'text-fg-strong')}>{EFFORT_LABELS[value]}</span>
          <Tooltip content={EFFORT_HELP} side="top">
            <button type="button" aria-label="About effort" className="ml-auto rounded-full text-icon-muted hover:text-icon">
              <CircleQuestionMark className="size-14" />
            </button>
          </Tooltip>
        </div>
        <div className="mt-18 flex justify-between text-sm text-fg-muted" aria-hidden="true">
          <span>Faster</span>
          <span>Smarter</span>
        </div>
        <RS.Root
          value={[index]}
          min={0}
          max={levels.length - 1}
          step={1}
          onValueChange={(v) => {
            const level = levels[v[0] ?? 0];
            if (level) onChange(level);
          }}
          className="relative mt-6 flex h-[var(--g-effort-track-height)] w-full touch-none items-center select-none"
        >
          <RS.Track className="relative h-full grow rounded-full bg-bg">
            {levels.map((level, i) =>
              i === index ? null : (
                <span
                  key={level}
                  aria-hidden="true"
                  className={cn(
                    'absolute top-1/2 -translate-x-1/2 -translate-y-1/2',
                    i === recommended ? 'h-8 w-1 bg-fg-secondary' : 'size-2 rounded-full bg-fg-muted'
                  )}
                  style={{ left: tickLeft(i, levels.length) }}
                />
              )
            )}
          </RS.Track>
          <RS.Thumb
            aria-label="Effort"
            aria-valuetext={EFFORT_LABELS[value]}
            className="block h-[var(--g-effort-knob-height)] w-[var(--g-effort-knob-width)] rounded-[5px] bg-fg-strong shadow-composer transition-ui"
          />
        </RS.Root>
        {recommended >= 0 ? (
          <div className="relative mt-4 h-16">
            <span className="absolute text-sm text-fg-muted" style={{ left: `calc(${tickLeft(recommended, levels.length)} - 6px)` }}>
              Recommended
            </span>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
