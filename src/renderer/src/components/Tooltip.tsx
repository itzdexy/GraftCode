import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactElement, ReactNode } from 'react';
import { Kbd } from './Badge';

export const TooltipProvider = RadixTooltip.Provider;

interface TooltipProps {
  content: ReactNode;
  shortcut?: string | undefined;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactElement;
}

export function Tooltip({ content, shortcut, side = 'bottom', children }: TooltipProps) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="z-[var(--g-z-toast)] flex max-w-[320px] items-center gap-6 rounded-sm border border-border bg-surface px-8 py-4 text-xs text-fg shadow-popover"
        >
          <span>{content}</span>
          {shortcut ? <Kbd>{shortcut}</Kbd> : null}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
