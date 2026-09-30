import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Folder, X } from 'lucide-react';
import type { EffortLevel, ModelRef } from '@shared/schemas/common';
import type { ModelInfo } from '@shared/schemas/models';
import { Badge } from '../../components/Badge';
import { Button, IconButton } from '../../components/Button';
import { ErrorState, LoadingState } from '../../components/States';
import { cn } from '../../lib/cn';
import { EFFORT_LABELS } from '../../lib/format';
import { errorText, invoke } from '../../lib/ipc';
import { useApp } from '../../stores/app';
import { useNav } from '../../stores/nav';
import { ModelListbox } from '../models/ModelListbox';
import { StepLayout, type StepProps } from './StepLayout';

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; models: ModelInfo[] };

/** Levels offered as a default; the long-horizon mode is chosen per session. */
function defaultLevels(model: ModelInfo | null): EffortLevel[] {
  return model?.effort ? model.effort.levels.filter((l) => l !== 'taproot') : [];
}

function EffortChoice({ model, value, onChange }: { model: ModelInfo; value: EffortLevel; onChange: (level: EffortLevel) => void }) {
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

export function DefaultsStep({ onBack }: StepProps) {
  const providerId = useApp((s) => s.settings?.onboarding.providerId ?? null);
  const savedEffort = useApp((s) => s.settings?.defaults.effort ?? 'medium');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [chosen, setChosen] = useState<ModelInfo | null>(null);
  const [chosenEffort, setChosenEffort] = useState<EffortLevel>(savedEffort);
  const [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchModels = useCallback(
    async (refresh: boolean): Promise<Load> => {
      try {
        const all = await invoke('models:list', { refresh });
        const entry = all.find((p) => p.providerId === providerId);
        if (!entry) return { state: 'error', message: 'The provider you added is missing. Go back and connect it again.' };
        if (entry.error) return { state: 'error', message: entry.error.message };
        if (entry.models.length === 0) return { state: 'error', message: 'This provider returned no models you can chat with.' };
        return { state: 'ready', models: entry.models };
      } catch (e) {
        return { state: 'error', message: errorText(e) };
      }
    },
    [providerId]
  );

  useEffect(() => {
    let cancelled = false;
    void fetchModels(false).then((result) => {
      if (!cancelled) setLoad(result);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchModels]);

  const retry = (): void => {
    setLoad({ state: 'loading' });
    void fetchModels(true).then(setLoad);
  };

  // Until the user picks, the first (featured) model and its default effort apply.
  const model = chosen ?? (load.state === 'ready' ? (load.models[0] ?? null) : null);
  const effort = model?.effort && !defaultLevels(model).includes(chosenEffort) ? model.effort.default : chosenEffort;

  const chooseModel = (m: ModelInfo): void => {
    setChosen(m);
    if (m.effort && !defaultLevels(m).includes(chosenEffort)) setChosenEffort(m.effort.default);
  };

  const pickFolder = async (): Promise<void> => {
    try {
      const chosen = await invoke('dialog:pickFolder', { title: 'Choose a project folder' });
      if (chosen) setFolder(chosen);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const finish = async (): Promise<void> => {
    if (!model) return;
    setBusy(true);
    setError(null);
    try {
      const ref: ModelRef = model.ref;
      const settings = await invoke('onboarding:complete', { model: ref, effort, projectPath: folder });
      useNav.getState().go({ name: 'home' });
      useApp.getState().finishOnboarding(settings);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <StepLayout
      title="Pick your defaults"
      description="New sessions start with these. You can change the model and effort in any session."
      onSubmit={finish}
      onBack={onBack}
      primaryLabel="Start using Graft"
      primaryDisabled={model === null}
      busy={busy}
      error={error}
    >
      <div className="flex flex-col gap-24">
        <section aria-label="Default model" className="flex flex-col gap-8">
          <h2 className="text-base font-medium text-fg-secondary">Model</h2>
          {load.state === 'loading' ? <LoadingState label="Loading models…" className="py-16" /> : null}
          {load.state === 'error' ? (
            <ErrorState title="Couldn't load models" message={load.message} onRetry={retry} className="py-16" />
          ) : null}
          {load.state === 'ready' ? (
            <ModelListbox models={load.models} value={model?.ref ?? null} onChange={chooseModel} label="Default model" autoFocus />
          ) : null}
        </section>

        {model?.effort ? (
          <section aria-label="Default effort" className="flex flex-col gap-8">
            <h2 className="text-base font-medium text-fg-secondary">Effort</h2>
            <p className="text-sm text-fg-muted">Higher effort thinks longer and works more thoroughly, but is slower and uses more tokens.</p>
            <EffortChoice model={model} value={effort} onChange={setChosenEffort} />
          </section>
        ) : null}

        <section aria-label="First project" className="flex flex-col gap-8">
          <h2 className="text-base font-medium text-fg-secondary">
            First project <span className="font-normal text-fg-muted">(optional)</span>
          </h2>
          {folder ? (
            <div className="flex max-w-[440px] items-center gap-8 rounded-md border border-border bg-surface py-4 pr-4 pl-10">
              <Folder className="size-14 shrink-0 text-icon" aria-hidden="true" />
              <span className="selectable min-w-0 flex-1 truncate text-base text-fg" title={folder}>
                {folder}
              </span>
              <Button size="sm" variant="ghost" onClick={() => void pickFolder()}>
                Change
              </Button>
              <IconButton label="Remove folder" size="xs" onClick={() => setFolder(null)}>
                <X className="size-14" />
              </IconButton>
            </div>
          ) : (
            <div>
              <Button variant="secondary" leading={<Folder className="size-14" />} onClick={() => void pickFolder()}>
                Choose a folder
              </Button>
            </div>
          )}
        </section>
      </div>
    </StepLayout>
  );
}
