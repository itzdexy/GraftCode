import * as RD from '@radix-ui/react-dialog';
import { useRef } from 'react';
import { X } from 'lucide-react';
import { IconButton } from '../../components/Button';
import { useNav, type SettingsSection } from '../../stores/nav';
import { SettingsBody } from './SettingsView';

/** What can be open over Settings and takes Escape before it does: another dialog, a menu, a popover, a tooltip. */
const OVER = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [data-radix-popper-content-wrapper]';

/**
 * Settings, as a window over the page you were on. The page underneath stays
 * as it was and keeps working; Escape, the close button and a click beside the
 * window show it again. Settings is still a route, so every link into it and
 * the history work as before: closing leaves the history as it was before
 * Settings opened, and Forward opens it again.
 */
export function SettingsWindow({ open, section }: { open: boolean; section: SettingsSection }) {
  const content = useRef<HTMLDivElement>(null);
  return (
    <RD.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) useNav.getState().closeSettings();
      }}
    >
      <RD.Portal>
        <RD.Overlay className="overlay-scrim fixed inset-0 z-[var(--g-z-dialog)] bg-overlay" />
        <RD.Content
          ref={content}
          aria-label="Settings"
          // The keyboard goes to the window as a whole. On its first button, that button's tooltip would open with the window.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            content.current?.focus();
          }}
          // Escape belongs to the innermost thing: a shortcut that is being recorded, or whatever is open over Settings.
          // That is asked here and not left to the order the layers were opened in, which lags a newly opened one by a frame.
          onEscapeKeyDown={(event) => {
            const window = content.current;
            const over = window !== null && [...document.querySelectorAll(OVER)].some((layer) => layer !== window && !window.contains(layer));
            if (over || document.querySelector('[data-recording="true"]')) event.preventDefault();
          }}
          // 1,000 by 720 at most, and never nearer than 32 px to the window's edge; its page scrolls inside it.
          className="overlay-dialog fixed top-1/2 left-1/2 z-[var(--g-z-dialog)] flex h-[min(720px,calc(100vh-64px))] w-[min(1000px,calc(100vw-64px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-bg text-fg shadow-popover outline-none"
        >
          <div className="flex h-40 shrink-0 items-center gap-8 border-b border-border-subtle pr-8 pl-16">
            <RD.Title className="min-w-0 flex-1 truncate text-md font-semibold text-fg-strong">Settings</RD.Title>
            <RD.Description className="sr-only">Escape closes Settings and shows the page underneath.</RD.Description>
            <RD.Close asChild>
              <IconButton label="Close" shortcut="Esc" size="sm">
                <X className="size-14" />
              </IconButton>
            </RD.Close>
          </div>
          <SettingsBody section={section} />
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
