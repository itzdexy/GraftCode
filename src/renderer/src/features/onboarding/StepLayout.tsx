import { useEffect, useId, useRef, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from '../../components/Button';
import { Spinner } from '../../components/ContextRing';

export interface StepProps {
  /** Persists the next step (and any extra onboarding state) and moves there. */
  onNext: () => Promise<void>;
  onBack: (() => Promise<void>) | null;
}

interface StepLayoutProps {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  onSubmit: () => void | Promise<void>;
  onBack: (() => Promise<void>) | null;
  primaryLabel: string;
  primaryVariant?: 'primary' | 'secondary';
  primaryDisabled?: boolean;
  busy?: boolean;
  /** Extra footer control placed before the primary button (e.g. "Remove picture"). */
  extra?: ReactNode;
  error?: string | null;
}

/**
 * Shared frame for onboarding steps: serif title, body, and a footer with
 * Back / primary action. Enter submits, Alt+Left goes back, and focus moves
 * to the step's [data-autofocus] element (or its title) when it appears.
 */
export function StepLayout({
  title,
  description,
  children,
  onSubmit,
  onBack,
  primaryLabel,
  primaryVariant = 'primary',
  primaryDisabled = false,
  busy = false,
  extra,
  error
}: StepLayoutProps) {
  const titleId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const target = formRef.current?.querySelector<HTMLElement>('[data-autofocus]') ?? headingRef.current;
    target?.focus();
  }, []);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (primaryDisabled || busy) return;
    void onSubmit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>): void => {
    if (event.altKey && event.key === 'ArrowLeft' && onBack && !busy) {
      event.preventDefault();
      void onBack();
    }
  };

  return (
    <form ref={formRef} onSubmit={submit} onKeyDown={onKeyDown} aria-labelledby={titleId} className="flex flex-col" noValidate>
      <h1 id={titleId} ref={headingRef} tabIndex={-1} className="font-serif text-title font-normal text-fg-strong outline-none">
        {title}
      </h1>
      {description ? <div className="mt-8 text-md text-fg-muted">{description}</div> : null}
      {children ? <div className="mt-24">{children}</div> : null}
      {error ? (
        <p role="alert" className="selectable mt-16 text-base text-danger">
          {error}
        </p>
      ) : null}
      <div className="mt-32 flex items-center gap-8">
        {onBack ? (
          <Button variant="ghost" leading={<ArrowLeft className="size-14" />} onClick={() => void onBack()} disabled={busy}>
            Back
          </Button>
        ) : null}
        <div className="flex-1" />
        {extra}
        <Button
          type="submit"
          variant={primaryVariant}
          disabled={primaryDisabled || busy}
          leading={busy ? <Spinner size={12} label="Working" /> : undefined}
        >
          {primaryLabel}
        </Button>
      </div>
    </form>
  );
}
