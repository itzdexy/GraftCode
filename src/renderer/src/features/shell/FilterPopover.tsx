import { useMemo, type ReactNode } from 'react';
import { Check, SlidersHorizontal } from 'lucide-react';
import { IconButton } from '../../components/Button';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/Popover';
import { cn } from '../../lib/cn';
import { baseName } from '../../lib/format';
import { useSessions } from '../../stores/sessions';
import { useUi } from '../../stores/ui';
import { filterActive, type DateFilter, type StatusFilter } from './sessionLists';

const STATUS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'attention', label: 'Needs attention' },
  { value: 'running', label: 'Running' },
  { value: 'idle', label: 'Idle' },
  { value: 'archived', label: 'Archived' }
];

const DATES: Array<{ value: DateFilter; label: string }> = [
  { value: 'any', label: 'Any time' },
  { value: 'day', label: 'Last 24 hours' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'Last 30 days' }
];

function Option({ selected, label, onSelect }: { selected: boolean; label: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onSelect}
      className="flex h-[var(--g-menu-row-height)] w-full items-center gap-8 rounded-md px-8 text-left text-base text-fg outline-none hover:bg-hover focus-visible:bg-hover"
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected ? <Check className="size-14 shrink-0 text-blue" aria-hidden="true" /> : null}
    </button>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col">
      <p className="px-8 pt-6 pb-4 text-sm text-fg-muted">{label}</p>
      {children}
    </div>
  );
}

/** Status / project / date filter for the sidebar lists. */
export function FilterPopover({ kind }: { kind: 'chat' | 'code' }) {
  const filter = useUi((s) => s.filter);
  const setFilter = useUi((s) => s.setFilter);
  const summaries = useSessions((s) => s.summaries);
  const projects = useMemo(() => {
    const paths = new Set<string>();
    for (const s of Object.values(summaries)) if (s.kind === 'code' && s.projectPath) paths.add(s.projectPath);
    return [...paths].sort((a, b) => baseName(a).localeCompare(baseName(b), undefined, { sensitivity: 'base' }));
  }, [summaries]);
  const active = filterActive(filter);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton label={active ? 'Filter (active)' : 'Filter'} size="xs" active={active} className="relative">
          <SlidersHorizontal className="size-14" />
          {active ? <span className="pointer-events-none absolute top-1 right-1 size-5 rounded-full bg-blue" aria-hidden="true" /> : null}
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[70vh] w-[240px] overflow-y-auto p-4" aria-label="Filter sessions">
        <Group label="Status">
          {STATUS.map((o) => (
            <Option key={o.value} label={o.label} selected={filter.status === o.value} onSelect={() => setFilter({ status: o.value })} />
          ))}
        </Group>
        {kind === 'code' && projects.length > 1 ? (
          <>
            <div className="mx-8 my-4 h-px bg-divider" />
            <Group label="Project">
              <Option label="All projects" selected={filter.project === null} onSelect={() => setFilter({ project: null })} />
              {projects.map((p) => (
                <Option key={p} label={baseName(p)} selected={filter.project === p} onSelect={() => setFilter({ project: p })} />
              ))}
            </Group>
          </>
        ) : null}
        <div className="mx-8 my-4 h-px bg-divider" />
        <Group label="Updated">
          {DATES.map((o) => (
            <Option key={o.value} label={o.label} selected={filter.date === o.value} onSelect={() => setFilter({ date: o.value })} />
          ))}
        </Group>
        <div className="mx-8 my-4 h-px bg-divider" />
        <button
          type="button"
          disabled={!active}
          onClick={() => useUi.getState().resetFilter()}
          className={cn(
            'flex h-[var(--g-menu-row-height)] w-full items-center rounded-md px-8 text-left text-base outline-none',
            active ? 'text-fg hover:bg-hover focus-visible:bg-hover' : 'text-fg-faint'
          )}
        >
          Clear filters
        </button>
      </PopoverContent>
    </Popover>
  );
}
