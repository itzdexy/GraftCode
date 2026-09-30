import * as RD from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { IconButton } from './Button';

export const Dialog = RD.Root;
export const DialogTrigger = RD.Trigger;
export const DialogClose = RD.Close;

interface DialogContentProps {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** Hide the corner close button (e.g. while a destructive action runs). */
  hideClose?: boolean;
}

export function DialogContent({ title, description, children, footer, className, hideClose }: DialogContentProps) {
  return (
    <RD.Portal>
      <RD.Overlay className="fixed inset-0 z-[var(--g-z-dialog)] bg-overlay data-[state=open]:animate-[graft-fade_var(--g-duration-base)_var(--g-ease)]" />
      <RD.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-[var(--g-z-dialog)] flex max-h-[85vh] w-[min(480px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-surface text-fg shadow-popover outline-none data-[state=open]:animate-[graft-menu-in_var(--g-duration-base)_var(--g-ease)]',
          className
        )}
      >
        <div className="flex items-start gap-12 px-20 pt-18">
          <div className="min-w-0 flex-1">
            <RD.Title className="text-md font-semibold text-fg-strong">{title}</RD.Title>
            {description ? (
              <RD.Description className="mt-4 text-base text-fg-muted">{description}</RD.Description>
            ) : (
              <RD.Description className="sr-only">{typeof title === 'string' ? title : 'Dialog'}</RD.Description>
            )}
          </div>
          {hideClose ? null : (
            <RD.Close asChild>
              <IconButton label="Close" tooltip={false} size="xs" className="-mr-6">
                <X className="size-14" />
              </IconButton>
            </RD.Close>
          )}
        </div>
        {children ? <div className="min-h-0 flex-1 overflow-y-auto px-20 pt-14 pb-4">{children}</div> : null}
        {footer ? <div className="flex items-center justify-end gap-8 px-20 pt-12 pb-16">{footer}</div> : null}
      </RD.Content>
    </RD.Portal>
  );
}
