import { useId, useState, type ReactNode } from 'react';
import { Button } from '../../components/Button';
import { Dialog, DialogContent } from '../../components/Dialog';
import { Switch } from '../../components/Field';
import { cn } from '../../lib/cn';
import { errorText } from '../../lib/ipc';
import { useApp } from '../../stores/app';
import { reportError } from '../../stores/toasts';
import type { AppSettingsPatch } from '@shared/schemas/appSettings';

/** A titled group of settings rows. */
export function Group({ title, description, actions, children, className }: { title?: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn('flex flex-col gap-8', className)}>
      {title || description || actions ? (
        <header className="flex items-end gap-12">
          <div className="min-w-0 flex-1">
            {title ? <h3 className="text-md font-medium text-fg-strong">{title}</h3> : null}
            {description ? <p className="mt-2 text-sm text-fg-muted">{description}</p> : null}
          </div>
          {actions}
        </header>
      ) : null}
      <div className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-card bg-raised">{children}</div>
    </section>
  );
}

/** One setting: label and help on the left, its control on the right. */
export function SettingRow({ label, description, control, children, labelFor }: { label: ReactNode; description?: ReactNode; control?: ReactNode; children?: ReactNode; labelFor?: string }) {
  return (
    <div className="flex flex-col gap-8 px-14 py-10">
      <div className="flex min-h-[28px] items-center gap-16">
        <div className="min-w-0 flex-1">
          {labelFor ? (
            <label htmlFor={labelFor} className="text-base text-fg">
              {label}
            </label>
          ) : (
            <p className="text-base text-fg">{label}</p>
          )}
          {description ? <p className="mt-2 text-sm text-fg-muted">{description}</p> : null}
        </div>
        {control ? <div className="flex shrink-0 items-center gap-6">{control}</div> : null}
      </div>
      {children}
    </div>
  );
}

/** Saves a settings patch, reporting failures as a toast. */
export function saveSettings(patch: AppSettingsPatch, failure = "Couldn't save the setting"): void {
  useApp
    .getState()
    .updateSettings(patch)
    .catch((error: unknown) => reportError(failure, error));
}

/** A row whose control is a switch bound to a setting. */
export function SwitchRow({ label, description, checked, onChange, disabled }: { label: string; description?: ReactNode; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return <SettingRow label={label} description={description} control={<Switch label={label} checked={checked} onChange={onChange} disabled={disabled} />} />;
}

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  children?: ReactNode;
}

/** Confirmation for actions that are hard to undo; errors stay in the dialog. */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, danger = false, onConfirm, children }: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent
        title={title}
        description={description}
        hideClose={busy}
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant={danger ? 'danger' : 'primary'} onClick={() => void run()} disabled={busy}>
              {busy ? 'Working…' : confirmLabel}
            </Button>
          </>
        }
      >
        {children}
        {error ? (
          <p role="alert" className="mt-8 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Labelled native select styled like the text fields. */
export function SelectField({ label, value, onChange, options, className }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }>; className?: string }) {
  const id = useId();
  return (
    <div className={cn('flex flex-col gap-6', className)}>
      <label htmlFor={id} className="text-base font-medium text-fg-secondary">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-32 w-full rounded-md border border-input-border bg-input px-8 text-base text-fg outline-none focus:border-border-strong"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
