import { Check } from 'lucide-react';
import type { AppSettings, OnboardingStep } from '@shared/schemas/appSettings';
import { Mark } from '../../brand/Mark';
import { Wordmark } from '../../brand/Wordmark';
import { cn } from '../../lib/cn';
import { invoke } from '../../lib/ipc';
import { useApp } from '../../stores/app';
import { reportError } from '../../stores/toasts';
import { AvatarStep } from './AvatarStep';
import { DefaultsStep } from './DefaultsStep';
import { KeyStep } from './KeyStep';
import { NameStep } from './NameStep';
import { ProviderStep } from './ProviderStep';
import type { StepProps } from './StepLayout';

type StepId = Exclude<OnboardingStep, 'done'>;

export const ONBOARDING_STEPS: ReadonlyArray<{ id: StepId; label: string }> = [
  { id: 'name', label: 'Name' },
  { id: 'avatar', label: 'Picture' },
  { id: 'provider', label: 'Provider' },
  { id: 'key', label: 'Connect' },
  { id: 'defaults', label: 'Defaults' }
];

const COMPONENTS: Record<StepId, (props: StepProps) => JSX.Element> = {
  name: NameStep,
  avatar: AvatarStep,
  provider: ProviderStep,
  key: KeyStep,
  defaults: DefaultsStep
};

async function persistStep(step: StepId, extra: Partial<AppSettings['onboarding']> = {}): Promise<void> {
  const settings = await invoke('settings:update', { onboarding: { step, ...extra } });
  useApp.getState().setSettings(settings);
}

function Stepper({ current, onSelect }: { current: StepId; onSelect: (step: StepId) => void }) {
  const currentIndex = ONBOARDING_STEPS.findIndex((s) => s.id === current);
  return (
    <nav aria-label="Setup progress">
      <ol className="flex flex-wrap items-center gap-x-6 gap-y-4">
        {ONBOARDING_STEPS.map((step, i) => {
          const done = i < currentIndex;
          const active = i === currentIndex;
          const content = (
            <>
              <span
                className={cn(
                  'inline-flex size-16 items-center justify-center rounded-full border text-2xs',
                  done && 'border-transparent bg-accent-dim text-accent-strong',
                  active && 'border-fg-secondary text-fg-strong',
                  !done && !active && 'border-border text-fg-faint'
                )}
                aria-hidden="true"
              >
                {done ? <Check className="size-10" strokeWidth={2.5} /> : i + 1}
              </span>
              <span>{step.label}</span>
            </>
          );
          return (
            <li key={step.id} className="flex items-center gap-6">
              {done ? (
                <button
                  type="button"
                  onClick={() => onSelect(step.id)}
                  className="inline-flex items-center gap-6 rounded-sm px-2 text-sm text-fg-secondary transition-ui hover:text-fg"
                  aria-label={`${step.label} (done)`}
                  title="Return to this step"
                >
                  {content}
                </button>
              ) : (
                <span
                  className={cn('inline-flex items-center gap-6 px-2 text-sm', active ? 'text-fg-strong' : 'text-fg-faint')}
                  aria-current={active ? 'step' : undefined}
                >
                  {content}
                </span>
              )}
              {i < ONBOARDING_STEPS.length - 1 ? <span className="h-px w-16 bg-border" aria-hidden="true" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Full-window first-run flow. The current step lives in settings, so quitting resumes here. */
export function Onboarding() {
  const stored = useApp((s) => s.settings?.onboarding.step ?? 'name');
  const step: StepId = stored === 'done' ? 'defaults' : stored;
  const index = ONBOARDING_STEPS.findIndex((s) => s.id === step);
  const Step = COMPONENTS[step];

  const next = ONBOARDING_STEPS[index + 1];
  const previous = ONBOARDING_STEPS[index - 1];
  const onNext = async (): Promise<void> => {
    if (next) await persistStep(next.id);
  };
  const onBack = previous ? () => persistStep(previous.id) : null;
  const select = (target: StepId): void => {
    persistStep(target).catch((e: unknown) => reportError("Couldn't go back", e));
  };

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="app-drag flex h-[var(--g-titlebar-height)] shrink-0 items-center gap-8 pr-[calc(var(--g-controls-right)+16px)] pl-[calc(var(--g-controls-left)+16px)]">
        <Mark size={16} motion="idle" />
        <Wordmark className="text-md" />
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[600px] flex-col px-24 pt-32 pb-40">
          <Stepper current={step} onSelect={select} />
          <div className="mt-36" key={step}>
            <Step onNext={onNext} onBack={onBack} />
          </div>
        </div>
      </main>
    </div>
  );
}
