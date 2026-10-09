import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { Check, Search } from 'lucide-react';
import type { ModelRef } from '@shared/schemas/common';
import type { ModelInfo } from '@shared/schemas/models';
import { fuzzyScore } from '@shared/fuzzy';
import { cn } from '../../lib/cn';
import { sameRef, useApp } from '../../stores/app';

interface ModelListboxProps {
  models: ModelInfo[];
  value: ModelRef | null;
  onChange: (model: ModelInfo) => void;
  label: string;
  autoFocus?: boolean;
  className?: string;
}

/**
 * Filterable single-select list of models (featured first, as the registry
 * orders them). The filter input owns focus; arrows move the active option
 * and Enter selects it, following the combobox pattern.
 */
export function ModelListbox({ models, value, onChange, label, autoFocus, className }: ModelListboxProps) {
  const id = useId();
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return models;
    return models
      .map((m) => {
        const scores = [fuzzyScore(q, m.label), fuzzyScore(q, m.ref.modelId)].filter((s): s is number => s !== null);
        return { m, score: scores.length > 0 ? Math.max(...scores) : null };
      })
      .filter((x): x is { m: ModelInfo; score: number } => x.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.m);
  }, [models, query]);
  const selectedIndex = filtered.findIndex((m) => sameRef(m.ref, value));
  // With models from several providers, each option names its provider.
  const providers = useApp((s) => s.providers);
  const multiProvider = new Set(models.map((m) => m.ref.providerId)).size > 1;
  const providerLabel = (providerId: string): string | null => (multiProvider ? (providers.find((p) => p.id === providerId)?.label ?? null) : null);
  const [active, setActive] = useState(Math.max(0, selectedIndex));
  const activeIndex = Math.min(active, Math.max(0, filtered.length - 1));
  const optionId = (i: number): string => `${id}-opt-${i}`;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.min(filtered.length - 1, Math.max(0, activeIndex + (event.key === 'ArrowDown' ? 1 : -1)));
      setActive(next);
      document.getElementById(optionId(next))?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      const model = filtered[activeIndex];
      if (model && model.availability?.selectable !== false && !sameRef(model.ref, value)) {
        event.preventDefault();
        onChange(model);
      }
    }
  };

  return (
    <div className={cn('group flex flex-col overflow-hidden rounded-lg border border-border bg-surface', className)}>
      <div className="flex items-center gap-8 border-b border-border px-10">
        <Search className="size-14 shrink-0 text-icon-muted" aria-hidden="true" />
        <input
          role="combobox"
          aria-label={label}
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={filtered.length > 0 ? optionId(activeIndex) : undefined}
          data-autofocus={autoFocus ? true : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={`Filter ${models.length} models`}
          spellCheck={false}
          className="h-32 min-w-0 flex-1 bg-transparent text-base text-fg outline-none"
        />
      </div>
      <div id={`${id}-list`} role="listbox" aria-label={label} className="max-h-[248px] overflow-y-auto p-4">
        {filtered.length === 0 ? <p className="px-8 py-10 text-base text-fg-muted">No models match “{query.trim()}”.</p> : null}
        {filtered.map((m, i) => {
          const selected = sameRef(m.ref, value);
          return (
            <div
              key={`${m.ref.providerId}/${m.ref.modelId}`}
              id={optionId(i)}
              role="option"
              aria-selected={selected}
              aria-disabled={m.availability?.selectable === false}
              title={m.availability?.reason ?? undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setActive(i);
                if (m.availability?.selectable === false) return;
                onChange(m);
              }}
              onMouseMove={() => setActive(i)}
              className={cn(
                'flex min-h-[var(--g-menu-row-2line-height)] cursor-default items-center gap-8 rounded-md px-8 py-4',
                // The row the keys act on. At rest it is marked only when it is also the chosen one:
                // with nothing chosen, a highlighted first row would read as a choice.
                i === activeIndex && (selected ? 'bg-hover' : 'group-focus-within:bg-hover group-hover:bg-hover')
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-base text-fg">{m.label}</p>
                <p className="truncate text-sm text-fg-muted">{[providerLabel(m.ref.providerId), m.description,
                  m.availability && m.availability.state !== 'available' ? m.availability.state.replaceAll('-', ' ') : null].filter(Boolean).join(' · ')}</p>
              </div>
              {selected ? <Check className="size-16 shrink-0 text-blue" aria-hidden="true" /> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
