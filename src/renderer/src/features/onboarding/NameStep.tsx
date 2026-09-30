import { useState } from 'react';
import { NicknameSchema } from '@shared/schemas/appSettings';
import { TextField } from '../../components/Field';
import { errorText, invoke } from '../../lib/ipc';
import { useApp } from '../../stores/app';
import { StepLayout, type StepProps } from './StepLayout';

export function NameStep({ onNext, onBack }: StepProps) {
  const initial = useApp((s) => s.settings?.profile.name ?? '');
  const [name, setName] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = NicknameSchema.safeParse(name);
  const validation = parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Enter a name.');

  const submit = async (): Promise<void> => {
    setTouched(true);
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      const settings = await invoke('profile:update', { name: parsed.data });
      useApp.getState().setSettings(settings);
      await onNext();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <StepLayout
      title="What should we call you?"
      description="Graft uses this to greet you. Only you will see it."
      onSubmit={submit}
      onBack={onBack}
      primaryLabel="Continue"
      busy={busy}
      error={error}
    >
      <TextField
        data-autofocus
        label="Your name"
        value={name}
        maxLength={60}
        autoComplete="nickname"
        spellCheck={false}
        placeholder="e.g. Sam"
        onChange={(e) => setName(e.target.value)}
        onBlur={() => setTouched(name.length > 0)}
        error={touched ? validation : null}
        className="max-w-[360px]"
      />
    </StepLayout>
  );
}
