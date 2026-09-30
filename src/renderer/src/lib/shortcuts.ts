import { useEffect, useLayoutEffect, useRef } from 'react';
import { DEFAULT_SHORTCUTS, type ShortcutId } from '@shared/schemas/appSettings';
import { useApp } from '../stores/app';

export interface Accelerator {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

const IS_MAC = window.graft.platform === 'darwin';

/** Parses "Ctrl+Shift+D", "Ctrl+`", "Shift+Tab", "Escape". "Ctrl" means Cmd on macOS. */
export function parseAccelerator(text: string): Accelerator | null {
  const parts = text.split('+').map((p) => p.trim());
  const key = parts.pop();
  if (!key) return null;
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  for (const m of mods) if (!['ctrl', 'cmd', 'mod', 'shift', 'alt', 'option'].includes(m)) return null;
  return {
    mod: mods.has('ctrl') || mods.has('cmd') || mods.has('mod'),
    shift: mods.has('shift'),
    alt: mods.has('alt') || mods.has('option'),
    key: key.toLowerCase()
  };
}

const CODE_KEYS: Record<string, string> = { Backquote: '`', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\' };

/** Layout-independent key name for an event: letters/digits/punctuation by physical code. */
export function eventKey(event: Pick<KeyboardEvent, 'key' | 'code'>): string {
  if (event.code.startsWith('Key')) return event.code.slice(3).toLowerCase();
  if (event.code.startsWith('Digit')) return event.code.slice(5);
  const punct = CODE_KEYS[event.code];
  if (punct) return punct;
  return event.key.toLowerCase();
}

export function matches(event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>, accel: Accelerator): boolean {
  const mod = IS_MAC ? event.metaKey : event.ctrlKey;
  const otherMod = IS_MAC ? event.ctrlKey : event.metaKey;
  return mod === accel.mod && !otherMod && event.shiftKey === accel.shift && event.altKey === accel.alt && eventKey(event) === accel.key;
}

/** Display form: "Ctrl+K" on Windows/Linux, "⌘K" on macOS. */
export function displayAccelerator(text: string): string {
  if (!IS_MAC) return text;
  const accel = parseAccelerator(text);
  if (!accel) return text;
  const key = accel.key.length === 1 ? accel.key.toUpperCase() : text.split('+').pop() ?? accel.key;
  return `${accel.alt ? '⌥' : ''}${accel.shift ? '⇧' : ''}${accel.mod ? '⌘' : ''}${key}`;
}

export function shortcutText(id: ShortcutId): string {
  const custom = useApp.getState().settings?.shortcuts[id];
  return displayAccelerator(custom ?? DEFAULT_SHORTCUTS[id]);
}

export function useShortcutLabel(id: ShortcutId): string {
  const custom = useApp((s) => s.settings?.shortcuts[id]);
  return displayAccelerator(custom ?? DEFAULT_SHORTCUTS[id]);
}

/**
 * Runs `handler` when the configured accelerator for `id` is pressed anywhere
 * in the window. Keys without a modifier (Escape, Shift+Tab) are skipped while
 * a dialog or menu is open so those keep their local meaning.
 */
export function useShortcut(id: ShortcutId, handler: (event: KeyboardEvent) => void, enabled = true): void {
  const accelText = useApp((s) => s.settings?.shortcuts[id] ?? DEFAULT_SHORTCUTS[id]);
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    const accel = parseAccelerator(accelText);
    if (!accel) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || !matches(event, accel)) return;
      if (!accel.mod && overlayOpen()) return;
      event.preventDefault();
      handlerRef.current(event);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [accelText, enabled]);
}

/** True while a Radix menu, popover or dialog is open. */
export function overlayOpen(): boolean {
  return document.querySelector('[data-radix-popper-content-wrapper], [role="dialog"][data-state="open"]') !== null;
}
