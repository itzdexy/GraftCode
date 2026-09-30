import { useMemo, useState, type KeyboardEvent } from 'react';
import { Check } from 'lucide-react';
import type { ModelInfo } from '@shared/schemas/models';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger } from '../../components/Menu';
import { cn } from '../../lib/cn';
import { useApp } from '../../stores/app';
import { moreModels, quickModels, sameModel } from '../models/modelChoice';

interface ModelQuickMenuProps {
  current: ModelInfo | null;
  onSelect: (model: ModelInfo) => void;
  disabled?: boolean;
  /** Text shown when no model is available. */
  emptyLabel?: string;
}

/** Code-mode model menu: featured models with 1–9 keys, then "More models". */
export function ModelQuickMenu({ current, onSelect, disabled = false, emptyLabel = 'No model' }: ModelQuickMenuProps) {
  const groups = useApp((s) => s.models);
  const providers = useApp((s) => s.providers);
  const loading = useApp((s) => s.modelsLoading);
  const [open, setOpen] = useState(false);
  const quick = useMemo(() => quickModels(groups, current), [groups, current]);
  const more = useMemo(() => moreModels(groups, quick), [groups, quick]);
  const errors = groups.filter((g) => g.error);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!/^[1-9]$/.test(event.key)) return;
    const model = quick[Number(event.key) - 1];
    if (!model) return;
    event.preventDefault();
    onSelect(model);
    setOpen(false);
  };

  const providerLabel = (id: string): string => providers.find((p) => p.id === id)?.label ?? id;

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={`Model: ${current?.label ?? emptyLabel}`}
          className="inline-flex h-22 max-w-[200px] items-center rounded-md px-6 text-base text-fg-tertiary transition-ui hover:bg-hover hover:text-fg data-[state=open]:bg-hover disabled:text-fg-faint"
        >
          <span className="truncate">{current?.label ?? (loading ? 'Loading models…' : emptyLabel)}</span>
        </button>
      </MenuTrigger>
      <MenuContent align="end" side="top" className="w-[240px]" onKeyDown={onKeyDown}>
        {quick.length === 0 ? <MenuLabel>{loading ? 'Loading models…' : 'No models available. Check your providers.'}</MenuLabel> : null}
        {quick.map((m, i) => {
          const selected = sameModel(m.ref, current?.ref);
          return (
            <MenuItem
              key={`${m.ref.providerId}/${m.ref.modelId}`}
              onSelect={() => onSelect(m)}
              trailing={
                selected ? (
                  <Check className="size-16 text-blue" aria-label="Selected" />
                ) : (
                  <span className={cn('w-16 text-center text-sm text-fg-muted')} aria-hidden="true">
                    {i + 1}
                  </span>
                )
              }
            >
              {m.label}
            </MenuItem>
          );
        })}
        {errors.map((g) => (
          <MenuLabel key={g.providerId} className="text-danger">
            {providerLabel(g.providerId)}: {g.error?.message}
          </MenuLabel>
        ))}
        {more.length > 0 ? (
          <>
            <MenuSeparator />
            <MenuSub>
              <MenuSubTrigger>More models</MenuSubTrigger>
              <MenuSubContent className="max-h-[min(420px,70vh)] w-[260px] overflow-y-auto">
                {more.map((g) => (
                  <div key={g.providerId} role="group" aria-label={providerLabel(g.providerId)}>
                    {more.length > 1 || providers.length > 1 ? <MenuLabel>{providerLabel(g.providerId)}</MenuLabel> : null}
                    {g.models.map((m) => (
                      <MenuItem key={m.ref.modelId} onSelect={() => onSelect(m)}>
                        {m.label}
                      </MenuItem>
                    ))}
                  </div>
                ))}
              </MenuSubContent>
            </MenuSub>
          </>
        ) : null}
      </MenuContent>
    </Menu>
  );
}
