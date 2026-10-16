import * as RD from '@radix-ui/react-dialog';
import { useRef } from 'react';
import { X } from 'lucide-react';
import { IconButton } from '../../components/Button';
import { useNav, type SettingsSection } from '../../stores/nav';
import { SettingsBody } from './SettingsView';

/** What can be open over Settings and takes Escape before it does: another dialog, a menu, a popover, a tooltip. */
const OVER = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [data-radix-popper-content-wrapper]';

/** A part of Settings that takes Escape before the window does marks itself with this (SettingsView's search). */
const OWN_ESCAPE = '[data-own-escape]';

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
          // Escape belongs to the innermost thing: a shortcut that is being recorded, whatever is open over Settings,
          // or the part of Settings the key was pressed in when that part takes it first (the search while it holds
          // text). That is asked here and not left to the order the layers were opened in, which lags a newly opened
          // one by a frame; and this handler hears the key before anything inside the window does, so what is inside
          // cannot keep the key by stopping it.
          onEscapeKeyDown={(event) => {
            const window = content.current;
            const over = window !== null && [...document.querySelectorAll(OVER)].some((layer) => layer !== window && !window.contains(layer));
            const inside = event.target instanceof Element && event.target.closest(OWN_ESCAPE) !== null;
            if (over || inside || document.querySelector('[data-recording="true"]')) event.preventDefault();
          }}
          // 1,000 by 720 at most, and never nearer than 32 px to the window's edge; its page scrolls inside it.
          className="overlay-dialog fixed top-1/2 left-1/2 z-[var(--g-z-dialog)] flex h-[min(720px,calc(100vh-64px))] w-[min(1000px,calc(100vw-64px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-bg text-fg shadow-popover outline-none"
        >
          {/* The list of pages has the heading "Settings": it is the window's title, so the window adds none of its own. */}
          <RD.Title className="sr-only">Settings</RD.Title>
          <RD.Description className="sr-only">Escape closes Settings and shows the page underneath.</RD.Description>
          <SettingsBody section={section} />
          <RD.Close asChild>
            <IconButton label="Close" shortcut="Esc" size="sm" className="absolute top-8 right-8">
              <X className="size-14" />
            </IconButton>
          </RD.Close>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
