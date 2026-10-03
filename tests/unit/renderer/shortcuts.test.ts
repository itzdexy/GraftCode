import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SHORTCUTS } from '../../../src/shared/schemas/appSettings';
import type * as ShortcutsModule from '../../../src/renderer/src/lib/shortcuts';

let lib: typeof ShortcutsModule;

beforeAll(async () => {
  // The module reads the platform from the preload bridge when it loads.
  (globalThis as { window?: unknown }).window = { graft: { platform: 'win32', invoke: () => Promise.reject(new Error('no bridge')), on: () => () => undefined } };
  lib = await import('../../../src/renderer/src/lib/shortcuts');
});

const key = (k: string, code: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({
  key: k,
  code,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods
});

describe('recording shortcuts', () => {
  it('turns key presses into accelerator text', () => {
    expect(lib.acceleratorFromEvent(key('k', 'KeyK', { ctrlKey: true }))).toBe('Ctrl+K');
    expect(lib.acceleratorFromEvent(key('K', 'KeyK', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+K');
    expect(lib.acceleratorFromEvent(key('Tab', 'Tab', { shiftKey: true }))).toBe('Shift+Tab');
    expect(lib.acceleratorFromEvent(key(',', 'Comma', { ctrlKey: true }))).toBe('Ctrl+,');
    expect(lib.acceleratorFromEvent(key('F5', 'F5'))).toBe('F5');
    expect(lib.acceleratorFromEvent(key(' ', 'Space', { altKey: true }))).toBe('Alt+Space');
    // A lone modifier is not a shortcut yet.
    expect(lib.acceleratorFromEvent(key('Control', 'ControlLeft', { ctrlKey: true }))).toBeNull();
  });

  it('round-trips recorded text through the matcher', () => {
    const text = lib.acceleratorFromEvent(key(',', 'Comma', { ctrlKey: true }))!;
    expect(lib.matchesAccelerator(key(',', 'Comma', { ctrlKey: true }), text)).toBe(true);
    expect(lib.matchesAccelerator(key(',', 'Comma'), text)).toBe(false);
    expect(lib.sameAccelerator('ctrl+k', 'Ctrl+K')).toBe(true);
    expect(lib.sameAccelerator('Ctrl+K', 'Ctrl+Shift+K')).toBe(false);
  });

  it('rejects bare keys for global shortcuts, editing keys and clashes', () => {
    const current = { ...DEFAULT_SHORTCUTS };
    expect(lib.shortcutProblem('search', 'K', current)).toMatch(/Add Ctrl or Alt/);
    expect(lib.shortcutProblem('search', 'Ctrl+C', current)).toMatch(/reserved/);
    expect(lib.shortcutProblem('search', 'Ctrl+N', current)).toMatch(/New session or chat/);
    expect(lib.shortcutProblem('search', 'Ctrl+Shift+P', current)).toMatch(/command palette/);
    expect(lib.shortcutProblem('search', 'Ctrl+Shift+O', current)).toBeNull();
    expect(lib.shortcutProblem('search', 'F6', current)).toBeNull();
    // Message-box shortcuts may be bare keys, but not single characters.
    expect(lib.shortcutProblem('interrupt', 'Escape', current)).toBeNull();
    expect(lib.shortcutProblem('cyclePermissionMode', 'M', current)).toMatch(/single character/);
  });
});
