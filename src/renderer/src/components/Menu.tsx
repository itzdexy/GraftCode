import * as DM from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { cn } from '../lib/cn';

/**
 * Dropdown menu styled after the reference model menu: 10px radius, 4px inner
 * padding, 29px rows (46px with a description), blue check on the selection.
 */
export const Menu = DM.Root;
export const MenuTrigger = DM.Trigger;
export const MenuGroup = DM.Group;
export const MenuRadioGroup = DM.RadioGroup;
export const MenuSub = DM.Sub;

const CONTENT =
  'overlay-pop z-[var(--g-z-popover)] min-w-[180px] overflow-hidden rounded-lg border border-border bg-surface p-4 text-base text-fg shadow-popover outline-none';

export const MenuContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DM.Content>>(
  function MenuContent({ className, sideOffset = 6, collisionPadding = 8, ...props }, ref) {
    return (
      <DM.Portal>
        <DM.Content
          ref={ref}
          sideOffset={sideOffset}
          collisionPadding={collisionPadding}
          className={cn(CONTENT, className)}
          {...props}
        />
      </DM.Portal>
    );
  }
);

export const MenuSubContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DM.SubContent>>(
  function MenuSubContent({ className, sideOffset = 6, collisionPadding = 8, ...props }, ref) {
    return (
      <DM.Portal>
        <DM.SubContent
          ref={ref}
          sideOffset={sideOffset}
          collisionPadding={collisionPadding}
          className={cn(CONTENT, className)}
          {...props}
        />
      </DM.Portal>
    );
  }
);

const ITEM =
  'relative flex w-full cursor-default items-center gap-8 rounded-md px-8 text-left outline-none select-none data-[disabled]:text-fg-faint data-[highlighted]:bg-hover';

interface ItemExtras {
  icon?: ReactNode;
  description?: ReactNode;
  checked?: boolean;
  shortcut?: ReactNode;
  trailing?: ReactNode;
  danger?: boolean;
}

function ItemBody({ icon, description, checked, shortcut, trailing, children }: ItemExtras & { children: ReactNode }) {
  return (
    <>
      {icon ? <span className="flex size-16 shrink-0 items-center justify-center text-icon">{icon}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{children}</span>
        {description ? <span className="truncate text-sm text-fg-muted">{description}</span> : null}
      </span>
      {trailing ? <span className="flex shrink-0 items-center gap-4 text-fg-muted">{trailing}</span> : null}
      {checked ? <Check className="size-16 shrink-0 text-blue" aria-hidden="true" /> : null}
      {shortcut !== undefined ? <span className="shrink-0 text-sm text-fg-muted">{shortcut}</span> : null}
    </>
  );
}

export const MenuItem = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DM.Item> & ItemExtras>(
  function MenuItem({ className, icon, description, checked, shortcut, trailing, danger, children, ...props }, ref) {
    return (
      <DM.Item
        ref={ref}
        className={cn(
          ITEM,
          description ? 'min-h-[var(--g-menu-row-2line-height)] py-4' : 'h-[var(--g-menu-row-height)]',
          danger && 'text-danger',
          className
        )}
        {...props}
      >
        <ItemBody
          icon={icon}
          description={description}
          checked={checked}
          shortcut={shortcut}
          trailing={trailing}
        >
          {children}
        </ItemBody>
      </DM.Item>
    );
  }
);

/** On/off row that stays open when toggled (role menuitemcheckbox), drawn with a switch. */
export const MenuSwitchItem = forwardRef<
  HTMLDivElement,
  Omit<ComponentPropsWithoutRef<typeof DM.CheckboxItem>, 'checked' | 'onCheckedChange'> & {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    icon?: ReactNode;
    description?: ReactNode;
  }
>(function MenuSwitchItem({ className, checked, onCheckedChange, icon, description, children, ...props }, ref) {
  return (
    <DM.CheckboxItem
      ref={ref}
      checked={checked}
      onCheckedChange={(value) => onCheckedChange(value === true)}
      onSelect={(event) => event.preventDefault()}
      className={cn(ITEM, description ? 'min-h-[var(--g-menu-row-2line-height)] py-4' : 'h-[var(--g-menu-row-height)]', className)}
      {...props}
    >
      {icon ? <span className="flex size-16 shrink-0 items-center justify-center text-icon">{icon}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{children}</span>
        {description ? <span className="truncate text-sm text-fg-muted">{description}</span> : null}
      </span>
      <span
        aria-hidden="true"
        className={cn('relative inline-flex h-16 w-28 shrink-0 items-center rounded-full border transition-ui', checked ? 'border-transparent bg-accent' : 'border-border bg-toggle-track')}
      >
        <span className={cn('block size-10 rounded-full transition-transform', checked ? 'translate-x-14 bg-switch-thumb-on' : 'translate-x-2 bg-switch-thumb')} />
      </span>
    </DM.CheckboxItem>
  );
});

export const MenuSubTrigger = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof DM.SubTrigger> & { icon?: ReactNode; value?: ReactNode }
>(function MenuSubTrigger({ className, icon, value, children, ...props }, ref) {
  return (
    <DM.SubTrigger
      ref={ref}
      className={cn(ITEM, 'h-[var(--g-menu-row-height)] data-[state=open]:bg-hover', className)}
      {...props}
    >
      {icon ? <span className="flex size-16 shrink-0 items-center justify-center text-icon">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {value !== undefined ? <span className="shrink-0 text-fg-muted">{value}</span> : null}
      <ChevronRight className="size-14 shrink-0 text-fg-muted" aria-hidden="true" />
    </DM.SubTrigger>
  );
});

export function MenuSeparator({ className }: { className?: string }) {
  return <DM.Separator className={cn('mx-8 my-4 h-px bg-divider', className)} />;
}

export function MenuLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <DM.Label className={cn('px-8 pt-6 pb-4 text-sm leading-[1.35] text-fg-muted', className)}>{children}</DM.Label>;
}
