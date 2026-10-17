import { create } from 'zustand';

/** How the Terminal panel draws and behaves; kept on this computer. */
export interface TerminalPrefs {
  cursorStyle: 'block' | 'bar' | 'underline';
  cursorBlink: boolean;
  /** Selecting text copies it, as in many terminals. */
  copyOnSelect: boolean;
  /** Lines kept above the screen. */
  scrollback: number;
}

export const CURSOR_STYLES = [
  { value: 'block', label: 'Block' },
  { value: 'bar', label: 'Bar' },
  { value: 'underline', label: 'Underline' }
] as const;

export const SCROLLBACK_CHOICES = [1000, 5000, 10_000, 50_000] as const;

export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = { cursorStyle: 'block', cursorBlink: true, copyOnSelect: false, scrollback: 5000 };

const STORAGE_KEY = 'graft.terminal.v1';

/** What was kept, field by field; anything unreadable is the default. */
export function readTerminalPrefs(storage: Pick<Storage, 'getItem'> | null): TerminalPrefs {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}');
    const value = raw && typeof raw === 'object' ? (raw as Partial<Record<keyof TerminalPrefs, unknown>>) : {};
    return {
      cursorStyle: CURSOR_STYLES.some((style) => style.value === value.cursorStyle) ? (value.cursorStyle as TerminalPrefs['cursorStyle']) : DEFAULT_TERMINAL_PREFS.cursorStyle,
      cursorBlink: typeof value.cursorBlink === 'boolean' ? value.cursorBlink : DEFAULT_TERMINAL_PREFS.cursorBlink,
      copyOnSelect: typeof value.copyOnSelect === 'boolean' ? value.copyOnSelect : DEFAULT_TERMINAL_PREFS.copyOnSelect,
      scrollback: (SCROLLBACK_CHOICES as readonly unknown[]).includes(value.scrollback) ? (value.scrollback as number) : DEFAULT_TERMINAL_PREFS.scrollback
    };
  } catch {
    return DEFAULT_TERMINAL_PREFS;
  }
}

interface TerminalPrefsState extends TerminalPrefs {
  set: (patch: Partial<TerminalPrefs>) => void;
}

export const useTerminalPrefs = create<TerminalPrefsState>((set, get) => ({
  ...readTerminalPrefs(typeof window === 'undefined' ? null : window.localStorage),
  set: (patch) => {
    set(patch);
    const { cursorStyle, cursorBlink, copyOnSelect, scrollback } = { ...get(), ...patch };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ cursorStyle, cursorBlink, copyOnSelect, scrollback }));
    } catch {
      // rocky: without storage the terminal starts with the defaults after a restart.
    }
  }
}));
