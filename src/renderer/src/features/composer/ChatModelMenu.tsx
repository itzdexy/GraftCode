import { useMemo } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { EffortLevel } from '@shared/schemas/common';
import type { ModelInfo } from '@shared/schemas/models';
import { Badge } from '../../components/Badge';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger } from '../../components/Menu';
import { EFFORT_LABELS } from '../../lib/format';
import { useApp } from '../../stores/app';
import { moreModels, quickModels, sameModel } from '../models/modelChoice';

export const CHAT_EFFORT_HELP = 'Higher effort means more careful answers, but they take longer and use more tokens.';

/** Levels offered in chat; the long-horizon agent mode only applies to code sessions. */
export function chatEffortLevels(model: ModelInfo | null): EffortLevel[] {
  return model?.effort ? model.effort.levels.filter((l) => l !== 'taproot') : [];
}

/** What a chat runs at: Taproot (a code-session mode) becomes the strongest chat level, as the agent does. */
export function chatEffort(model: ModelInfo | null, effort: EffortLevel | null): EffortLevel | null {
  if (effort !== 'taproot') return effort;
  return chatEffortLevels(model).at(-1) ?? null;
}

interface ChatModelMenuProps {
  model: ModelInfo | null;
  effort: EffortLevel | null;
  onModel: (model: ModelInfo) => void;
  onEffort: (effort: EffortLevel) => void;
  disabled?: boolean;
}

/** Chat model menu: featured models with descriptions, an Effort submenu and More models. */
export function ChatModelMenu({ model, effort, onModel, onEffort, disabled = false }: ChatModelMenuProps) {
  const groups = useApp((s) => s.models);
  const providers = useApp((s) => s.providers);
  const loading = useApp((s) => s.modelsLoading);
  const featured = useMemo(() => quickModels(groups, model, 6), [groups, model]);
  const more = useMemo(() => moreModels(groups, featured), [groups, featured]);
  const levels = chatEffortLevels(model);
  const providerLabel = (id: string): string => providers.find((p) => p.id === id)?.label ?? id;

  return (
    <Menu>
      <MenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={`Model: ${model?.label ?? 'none'}${effort ? `, effort ${EFFORT_LABELS[effort]}` : ''}`}
          className="inline-flex h-28 max-w-[260px] items-center gap-6 rounded-md px-8 text-base transition-ui hover:bg-hover data-[state=open]:bg-hover"
        >
          <span className="truncate font-medium text-fg-tertiary">{model?.label ?? (loading ? 'Loading models…' : 'No model')}</span>
          {effort && levels.length > 0 ? <span className="shrink-0 text-fg-muted">{EFFORT_LABELS[effort]}</span> : null}
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="w-[268px]">
        {featured.length === 0 ? <MenuLabel>{loading ? 'Loading models…' : 'No models available. Check your providers.'}</MenuLabel> : null}
        {featured.map((m) => (
          <MenuItem key={`${m.ref.providerId}/${m.ref.modelId}`} description={m.description} checked={sameModel(m.ref, model?.ref)} onSelect={() => onModel(m)}>
            {m.label}
          </MenuItem>
        ))}
        {levels.length > 0 && effort ? (
          <>
            <MenuSeparator />
            <MenuSub>
              <MenuSubTrigger value={EFFORT_LABELS[effort]}>Effort</MenuSubTrigger>
              <MenuSubContent className="w-[280px]">
                <MenuLabel>{CHAT_EFFORT_HELP}</MenuLabel>
                {levels.map((level) => (
                  <MenuItem
                    key={level}
                    checked={level === effort}
                    onSelect={() => onEffort(level)}
                    trailing={
                      level === model?.effort?.recommended ? (
                        <Badge>Recommended</Badge>
                      ) : level === 'max' ? (
                        <Badge tone="warning" icon={<TriangleAlert className="size-10" aria-hidden="true" />}>
                          Much higher usage
                        </Badge>
                      ) : undefined
                    }
                  >
                    {EFFORT_LABELS[level]}
                  </MenuItem>
                ))}
              </MenuSubContent>
            </MenuSub>
          </>
        ) : null}
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
                      <MenuItem key={m.ref.modelId} onSelect={() => onModel(m)}>
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
