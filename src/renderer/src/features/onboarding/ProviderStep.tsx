import { useRef, useState, type KeyboardEvent } from 'react';
import { Check } from 'lucide-react';
import { PROVIDER_KINDS, type ProviderKind } from '@shared/schemas/common';
import { PROVIDER_KIND_INFO } from '@shared/providerKinds';
import { Badge } from '../../components/Badge';
import { cn } from '../../lib/cn';
import { errorText, invoke } from '../../lib/ipc';
import { useApp } from '../../stores/app';
import { StepLayout, type StepProps } from './StepLayout';

function isKind(value: string | null | undefined): value is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(value ?? '');
}

export function ProviderStep({ onNext, onBack }: StepProps) {
  const savedKind = useApp((s) => s.settings?.onboarding.providerKind);
  const [kind, setKind] = useState<ProviderKind | null>(isKind(savedKind) ? savedKind : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const submit = async (chosen: ProviderKind | null = kind): Promise<void> => {
    if (!chosen || busy) return;
    setBusy(true);
    setError(null);
    try {
      const settings = await invoke('settings:update', { onboarding: { providerKind: chosen } });
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
      description="Graft talks to the provider directly with your own key. You can add more providers later in Settings."
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
    </StepLayout>
  );
}
