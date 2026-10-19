import { create } from 'zustand';

/** How the Changes panel shows a diff; kept on this computer. */
export interface DiffPrefs {
  split: boolean;
  wrap: boolean;
  /** Leaves out changes of whitespace alone (git diff -w). */
  ignoreWhitespace: boolean;
}

export const DEFAULT_DIFF_PREFS: DiffPrefs = { split: false, wrap: false, ignoreWhitespace: false };

const STORAGE_KEY = 'graft.diff.v1';

export function readDiffPrefs(storage: Pick<Storage, 'getItem'> | null): DiffPrefs {
  try {
    const raw: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}');
    const value = raw && typeof raw === 'object' ? (raw as Partial<Record<keyof DiffPrefs, unknown>>) : {};
    const flag = (key: keyof DiffPrefs): boolean => (typeof value[key] === 'boolean' ? value[key] : DEFAULT_DIFF_PREFS[key]);
    return { split: flag('split'), wrap: flag('wrap'), ignoreWhitespace: flag('ignoreWhitespace') };
  } catch {
    return DEFAULT_DIFF_PREFS;
  }
}

interface DiffPrefsState extends DiffPrefs {
  set: (patch: Partial<DiffPrefs>) => void;
}

export const useDiffPrefs = create<DiffPrefsState>((set, get) => ({
  ...readDiffPrefs(typeof window === 'undefined' ? null : window.localStorage),
  set: (patch) => {
    set(patch);
    const { split, wrap, ignoreWhitespace } = { ...get(), ...patch };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ split, wrap, ignoreWhitespace }));
    } catch {
      // rocky: without storage the diff opens unified, unwrapped, with whitespace, after a restart.
    }
  }
}));
