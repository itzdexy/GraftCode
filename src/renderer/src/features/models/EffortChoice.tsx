import { useRef, type KeyboardEvent } from 'react';
import type { EffortLevel } from '@shared/schemas/common';
import type { ModelInfo } from '@shared/schemas/models';
import { Badge } from '../../components/Badge';
import { cn } from '../../lib/cn';
import { EFFORT_LABELS } from '../../lib/format';

/** Levels offered as a default; the long-horizon mode is chosen per session. */
export function defaultLevels(model: ModelInfo | null): EffortLevel[] {
  return model?.effort ? model.effort.levels.filter((l) => l !== 'taproot') : [];
}

/** Radio row of effort levels for a default (onboarding, Settings → Models). */
export function EffortChoice({ model, value, onChange }: { model: ModelInfo; value: EffortLevel; onChange: (level: EffortLevel) => void }) {
  const levels = defaultLevels(model);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(0, levels.indexOf(value));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = Math.min(levels.length - 1, Math.max(0, index + delta));
    const level = levels[next];
    if (level) {
      onChange(level);
      refs.current[next]?.focus();
    }
  };
  return (
    <div role="radiogroup" aria-label="Effort" onKeyDown={onKeyDown} className="flex flex-wrap gap-6">
      {levels.map((level, i) => {
        const selected = level === value;
        return (
          <button
            key={level}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={i === index ? 0 : -1}
            onClick={() => onChange(level)}
            className={cn(
              'inline-flex h-28 items-center gap-6 rounded-md border px-10 text-base transition-ui',
              selected ? 'border-toggle-thumb-border bg-toggle-thumb text-fg-strong' : 'border-border text-fg-secondary hover:bg-hover'
            )}
          >
            {EFFORT_LABELS[level]}
            {model.effort?.recommended === level ? <Badge>Recommended</Badge> : null}
          </button>
        );
      })}
    </div>
  );
}
