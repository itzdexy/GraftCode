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

  it('has a key for finding in the conversation that clashes with no other', () => {
    expect(DEFAULT_SHORTCUTS.findInTranscript).toBe('Ctrl+F');
    expect(lib.SHORTCUT_DESCRIPTIONS.findInTranscript).toBe('Find in the conversation');
    expect(lib.shortcutProblem('findInTranscript', 'Ctrl+F', DEFAULT_SHORTCUTS)).toBeNull();
    expect(lib.shortcutProblem('search', 'Ctrl+F', DEFAULT_SHORTCUTS)).toMatch(/Find in the conversation/);
  });

  it('has keys for opening a file and a symbol by name', () => {
    expect([DEFAULT_SHORTCUTS.quickOpen, DEFAULT_SHORTCUTS.goToSymbol]).toEqual(['Ctrl+P', 'Ctrl+T']);
    expect([lib.SHORTCUT_DESCRIPTIONS.quickOpen, lib.SHORTCUT_DESCRIPTIONS.goToSymbol]).toEqual(['Open a file by name', 'Go to a symbol by name']);
    expect(lib.shortcutProblem('quickOpen', 'Ctrl+P', DEFAULT_SHORTCUTS)).toBeNull();
    expect(lib.shortcutProblem('goToSymbol', 'Ctrl+T', DEFAULT_SHORTCUTS)).toBeNull();
  });

  it('has a key for searching the text of the project that clashes with no other', () => {
    expect(DEFAULT_SHORTCUTS.searchFiles).toBe('Ctrl+Shift+H');
    expect(lib.SHORTCUT_DESCRIPTIONS.searchFiles).toBe('Search in the files of the project');
    expect(lib.shortcutProblem('searchFiles', 'Ctrl+Shift+H', DEFAULT_SHORTCUTS)).toBeNull();
    expect(lib.shortcutProblem('search', 'Ctrl+Shift+H', DEFAULT_SHORTCUTS)).toMatch(/Search in the files of the project/);
  });
});
