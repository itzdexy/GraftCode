import * as RP from '@radix-ui/react-popover';
import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { cn } from '../lib/cn';

export const Popover = RP.Root;
export const PopoverTrigger = RP.Trigger;
export const PopoverAnchor = RP.Anchor;
export const PopoverClose = RP.Close;

export const PopoverContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof RP.Content>>(
  function PopoverContent({ className, sideOffset = 6, collisionPadding = 8, ...props }, ref) {
    return (
      <RP.Portal>
        <RP.Content
          ref={ref}
          sideOffset={sideOffset}
          collisionPadding={collisionPadding}
          className={cn(
            'z-[var(--g-z-popover)] rounded-lg border border-border bg-surface text-base text-fg shadow-popover outline-none data-[state=open]:animate-[graft-menu-in_var(--g-duration-fast)_var(--g-ease)]',
            className
          )}
          {...props}
        />
      </RP.Portal>
    );
  }
);
