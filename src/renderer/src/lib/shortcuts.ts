import { useEffect, useLayoutEffect, useRef } from 'react';
import { DEFAULT_SHORTCUTS, SHORTCUT_IDS, type ShortcutId } from '@shared/schemas/appSettings';
import { useApp } from '../stores/app';

export interface Accelerator {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

const IS_MAC = window.graft.platform === 'darwin';

export const SHORTCUT_DESCRIPTIONS: Record<ShortcutId, string> = {
  newSession: 'New session or chat',
  search: 'Search chats and sessions',
  toggleSidebar: 'Show or hide the sidebar',
  toggleTerminal: 'Toggle the terminal panel',
  toggleChanges: 'Toggle the changes panel',
  focusComposer: 'Focus the message box',
  interrupt: 'Stop the running session',
  cyclePermissionMode: 'Cycle permission mode (in the message box)',
  openSettings: 'Open settings'
};

/** Shortcuts that act inside the message box may use bare keys; the rest need Ctrl or Alt. */
const LOCAL_SHORTCUTS: ReadonlySet<ShortcutId> = new Set(['interrupt', 'cyclePermissionMode']);
const RESERVED = ['Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z'];

/** Why an accelerator can't be used for `id`, or null when it can. */
export function shortcutProblem(id: ShortcutId, accel: string, current: Record<ShortcutId, string>): string | null {
  const parsed = parseAccelerator(accel);
  if (!parsed) return 'That key combination isn’t supported.';
  const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/.test(parsed.key);
  if (!LOCAL_SHORTCUTS.has(id) && !parsed.mod && !parsed.alt && !functionKey) return 'Add Ctrl or Alt so typing never triggers it.';
  if (LOCAL_SHORTCUTS.has(id) && !parsed.mod && !parsed.alt && !parsed.shift && parsed.key.length === 1) return 'A single character would get in the way of typing.';
  if (RESERVED.some((r) => sameAccelerator(r, accel))) return 'That combination is reserved for editing text.';
  const clash = SHORTCUT_IDS.find((other) => other !== id && sameAccelerator(current[other], accel));
  return clash ? `Already used for “${SHORTCUT_DESCRIPTIONS[clash]}”.` : null;
}

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
  if (event.code === 'Space') return 'space';
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

/** True when the configured accelerator text matches the event (unparseable text never matches). */
export function matchesAccelerator(event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>, text: string): boolean {
  const accel = parseAccelerator(text);
  return accel !== null && matches(event, accel);
}

/** Compares two accelerator strings by meaning ("ctrl+k" equals "Ctrl+K"). */
export function sameAccelerator(a: string, b: string): boolean {
  const x = parseAccelerator(a);
  const y = parseAccelerator(b);
  return x !== null && y !== null && x.mod === y.mod && x.shift === y.shift && x.alt === y.alt && x.key === y.key;
}

const KEY_NAMES: Record<string, string> = {
  escape: 'Escape',
  tab: 'Tab',
  enter: 'Enter',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight'
};
const MODIFIER_KEYS = new Set(['control', 'shift', 'alt', 'meta', 'os', 'altgraph', 'capslock', 'contextmenu', 'dead', 'unidentified', 'process']);

/** Accelerator text for a key press while recording a shortcut; null for a lone modifier. */
export function acceleratorFromEvent(event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): string | null {
  const key = eventKey(event);
  if (MODIFIER_KEYS.has(key)) return null;
  const name = KEY_NAMES[key] ?? (/^f\d{1,2}$/.test(key) ? key.toUpperCase() : key.length === 1 ? key.toUpperCase() : null);
  if (!name) return null;
  const parts: string[] = [];
  if (IS_MAC ? event.metaKey : event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(name);
  return parts.join('+');
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
