import { useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { PROVIDER_KINDS, type ProviderKind } from '@shared/schemas/common';
import { PROVIDER_KIND_INFO } from '@shared/providerKinds';
import { Badge } from '../../components/Badge';
import { cn } from '../../lib/cn';
import { errorText, invoke } from '../../lib/ipc';
import { useApp } from '../../stores/app';
import { ProviderPicker, type PickedProvider } from '../providers/ProviderPicker';
import { NATIVE_PRESET } from '../providers/targets';
import { StepLayout, type StepProps } from './StepLayout';

function isKind(value: string | null | undefined): value is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(value ?? '');
}

export function ProviderStep({ onNext, onBack }: StepProps) {
  const savedKind = useApp((s) => s.settings?.onboarding.providerKind);
  const savedPreset = useApp((s) => s.settings?.onboarding.providerPreset ?? null);
  const [kind, setKind] = useState<ProviderKind | null>(isKind(savedKind) && (savedPreset === null || savedPreset === NATIVE_PRESET[savedKind]) ? savedKind : null);
  const [browsing, setBrowsing] = useState(isKind(savedKind) && savedPreset !== null && savedPreset !== NATIVE_PRESET[savedKind]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const submit = async (chosen: ProviderKind | null = kind, preset: string | null = chosen ? NATIVE_PRESET[chosen] : null): Promise<void> => {
    if (!chosen || busy) return;
    setBusy(true);
    setError(null);
    try {
      const settings = await invoke('settings:update', { onboarding: { providerKind: chosen, providerPreset: preset } });
      useApp.getState().setSettings(settings);
      await onNext();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = kind ? PROVIDER_KINDS.indexOf(kind) : -1;
    const columns = window.innerWidth >= 720 ? 3 : 2;
    const deltas: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns };
    const delta = deltas[event.key];
    if (delta !== undefined) {
      event.preventDefault();
      const next = current === -1 ? 0 : Math.min(PROVIDER_KINDS.length - 1, Math.max(0, current + delta));
      const nextKind = PROVIDER_KINDS[next];
      if (nextKind) {
        setKind(nextKind);
        refs.current[next]?.focus();
      }
    } else if (event.key === 'Enter' && kind) {
      event.preventDefault();
      void submit();
    }
  };

  const focusIndex = kind ? PROVIDER_KINDS.indexOf(kind) : 0;

  return (
    <StepLayout
      title="Choose a model provider"
      description="Graft talks to the provider directly with your own key. Pick one of these, or search more than 200 others below. You can add more later in Settings."
      onSubmit={() => submit()}
      onBack={onBack}
      primaryLabel="Continue"
      primaryDisabled={kind === null}
      busy={busy}
      error={error}
    >
      <div
        role="radiogroup"
        aria-label="Provider"
        onKeyDown={onKeyDown}
        className="grid grid-cols-2 gap-8 min-[720px]:grid-cols-3"
      >
        {PROVIDER_KINDS.map((k, i) => {
          const info = PROVIDER_KIND_INFO[k];
          const selected = kind === k;
          return (
            <button
              key={k}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={i === focusIndex ? 0 : -1}
              data-autofocus={i === focusIndex ? true : undefined}
              onClick={() => setKind(k)}
              onDoubleClick={() => {
                setKind(k);
                void submit(k);
              }}
              className={cn(
                'relative flex min-h-[84px] flex-col items-start gap-4 rounded-lg border px-12 py-10 text-left transition-ui',
                selected ? 'border-border-strong bg-hover' : 'border-border bg-surface hover:bg-raised'
              )}
            >
              <span className="flex w-full items-center gap-6 pr-18">
                <span className="text-md font-medium text-fg-strong">{info.name}</span>
                {k === 'ollama' ? <Badge>Local</Badge> : null}
              </span>
              <span className="text-sm text-fg-muted">{info.description}</span>
              {selected ? <Check className="absolute top-10 right-10 size-14 text-blue" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
      <div className="mt-12">
        <button
          type="button"
          aria-expanded={browsing}
          onClick={() => setBrowsing(!browsing)}
          className="inline-flex h-28 items-center gap-4 rounded-md px-6 text-base text-fg-secondary transition-ui hover:bg-hover hover:text-fg"
        >
          {browsing ? <ChevronDown className="size-14" aria-hidden="true" /> : <ChevronRight className="size-14" aria-hidden="true" />}
          More providers
        </button>
        {browsing ? (
          <ProviderPicker
            className="mt-8"
            autoFocus
            onPick={(row: PickedProvider) => {
              if (row.type === 'custom') void submit('openai-compatible', null);
              else void submit(row.preset.kind, row.preset.id);
            }}
          />
        ) : null}
      </div>
    </StepLayout>
  );
}
