import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { Search } from 'lucide-react';
import type { ProviderPreset } from '@shared/schemas/models';
import { Badge } from '../../components/Badge';
import { ErrorState, LoadingState } from '../../components/States';
import { cn } from '../../lib/cn';
import { errorText } from '../../lib/ipc';
import { useApp } from '../../stores/app';
import { orderPresets, presetMatches } from './targets';

/** A row in the picker: a catalog preset, or the custom OpenAI-compatible endpoint. */
export type PickedProvider = { type: 'preset'; preset: ProviderPreset } | { type: 'custom' };

function detail(preset: ProviderPreset): string {
  if (preset.kind === 'ollama' || preset.local) return 'Runs locally';
  if (preset.kind !== 'openai-compatible') return 'Built-in connection';
  return preset.modelCount > 0 ? `${preset.modelCount} models` : 'OpenAI-compatible';
}

/**
 * Searchable list of every provider Graft can reach (200+ from the catalog).
 * The search box keeps focus; arrows move through results and Enter picks.
 */
export function ProviderPicker({ onPick, autoFocus = false, className }: { onPick: (picked: PickedProvider) => void; autoFocus?: boolean; className?: string }) {
  const presets = useApp((s) => s.presets);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const id = useId();

  useEffect(() => {
    if (presets) return;
    useApp
      .getState()
      .loadPresets()
      .catch((e: unknown) => setError(errorText(e)));
  }, [presets]);

  const rows = useMemo((): PickedProvider[] => {
    if (!presets) return [];
    const matching = presets.filter((p) => presetMatches(p, query));
    const { featured, rest } = query.trim() ? { featured: [], rest: matching } : orderPresets(matching);
    const custom: PickedProvider[] = !query.trim() || 'custom endpoint openai-compatible'.includes(query.trim().toLowerCase()) ? [{ type: 'custom' }] : [];
    return [...featured.map((p): PickedProvider => ({ type: 'preset', preset: p })), ...custom, ...rest.map((p): PickedProvider => ({ type: 'preset', preset: p }))];
  }, [presets, query]);
  const featuredCount = query.trim() ? 0 : rows.findIndex((r) => r.type === 'custom') + 1;
  const activeIndex = Math.min(active, Math.max(0, rows.length - 1));
  const optionId = (i: number): string => `${id}-opt-${i}`;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.min(rows.length - 1, Math.max(0, activeIndex + (event.key === 'ArrowDown' ? 1 : -1)));
      setActive(next);
      document.getElementById(optionId(next))?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      const row = rows[activeIndex];
      if (row) {
        event.preventDefault();
        onPick(row);
      }
    }
  };

  if (error) return <ErrorState title="Couldn't load providers" message={error} onRetry={() => setError(null)} className="py-16" />;
  if (!presets) return <LoadingState label="Loading providers…" className="py-16" />;

  return (
    <div className={cn('flex flex-col overflow-hidden rounded-lg border border-border bg-surface', className)}>
      <div className="flex items-center gap-8 border-b border-border px-10">
        <Search className="size-14 shrink-0 text-icon-muted" aria-hidden="true" />
        <input
          role="combobox"
          aria-label="Search providers"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={rows.length > 0 ? optionId(activeIndex) : undefined}
          data-autofocus={autoFocus ? true : undefined}
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={`Search ${presets.length} providers`}
          spellCheck={false}
          className="h-34 min-w-0 flex-1 bg-transparent text-base text-fg outline-none"
        />
      </div>
      <div id={`${id}-list`} role="listbox" aria-label="Providers" className="max-h-[320px] min-h-0 flex-1 overflow-y-auto p-4">
        {rows.length === 0 ? <p className="px-8 py-10 text-base text-fg-muted">No provider matches “{query.trim()}”. Add it as a custom endpoint.</p> : null}
        {rows.map((row, i) => {
          const name = row.type === 'custom' ? 'Custom endpoint' : row.preset.name;
          const sub = row.type === 'custom' ? 'Any server with the OpenAI chat completions API' : detail(row.preset);
          return (
            <div key={row.type === 'custom' ? 'custom' : row.preset.id}>
              {i === featuredCount && featuredCount > 0 ? (
                <p className="px-8 pt-8 pb-4 text-xs font-medium tracking-wide text-fg-faint uppercase" role="presentation">
                  All providers
                </p>
              ) : null}
              <div
                id={optionId(i)}
                role="option"
                aria-selected={i === activeIndex}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick(row)}
                onMouseMove={() => setActive(i)}
                className={cn('flex min-h-[38px] cursor-default items-center gap-8 rounded-md px-8 py-4', i === activeIndex && 'bg-hover')}
              >
                <span className="min-w-0 flex-1 truncate text-base text-fg">{name}</span>
                {row.type === 'preset' && (row.preset.kind === 'ollama' || row.preset.local) ? <Badge>Local</Badge> : null}
                <span className="shrink-0 text-sm text-fg-muted">{sub}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
