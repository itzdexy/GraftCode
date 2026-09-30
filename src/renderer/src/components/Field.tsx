import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes
} from 'react';
import { cn } from '../lib/cn';

const CONTROL =
  'w-full rounded-md border border-input-border bg-input px-10 text-base text-fg transition-ui placeholder:text-fg-placeholder focus:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-0 disabled:text-fg-muted aria-[invalid=true]:border-danger';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  trailing?: ReactNode;
  inputClassName?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, trailing, className, inputClassName, id, ...rest },
  ref
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('flex flex-col gap-6', className)}>
      {label ? (
        <label htmlFor={inputId} className="text-base font-medium text-fg-secondary">
          {label}
        </label>
      ) : null}
      <div className="relative flex items-center">
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(CONTROL, 'h-32', trailing ? 'pr-36' : '', inputClassName)}
          {...rest}
        />
        {trailing ? <div className="absolute right-4 flex items-center">{trailing}</div> : null}
      </div>
      {hint && !error ? (
        <p id={hintId} className="text-sm text-fg-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
});

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, className, id, ...rest },
  ref
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className="flex flex-col gap-6">
      {label ? (
        <label htmlFor={inputId} className="text-base font-medium text-fg-secondary">
          {label}
        </label>
      ) : null}
      <textarea ref={ref} id={inputId} className={cn(CONTROL, 'min-h-[72px] resize-y py-8 leading-[1.45]', className)} {...rest} />
    </div>
  );
});

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
}

/** Native checkbox (keyboard + a11y for free) drawn as the 11px reference box. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, className, ...rest },
  ref
) {
  return (
    <label className={cn('inline-flex cursor-default items-center gap-4 text-base text-fg-secondary', className)}>
      <input
        ref={ref}
        type="checkbox"
        className="size-11 appearance-none rounded-[2px] border border-key-border bg-transparent transition-ui checked:border-blue checked:bg-blue checked:bg-[url('data:image/svg+xml;utf8,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2012%2012%22%3E%3Cpath%20d=%22M2.5%206.2l2.3%202.3%204.7-5%22%20fill=%22none%22%20stroke=%22white%22%20stroke-width=%221.8%22%20stroke-linecap=%22round%22%20stroke-linejoin=%22round%22/%3E%3C/svg%3E')] checked:bg-center checked:bg-no-repeat"
        {...rest}
      />
      <span>{label}</span>
    </label>
  );
});
