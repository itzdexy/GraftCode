import { create } from 'zustand';
import type { BrowserStateView } from '@shared/schemas/panels';

export type PanelId = 'terminal' | 'changes' | 'browser' | 'tasks';

export interface SessionPanels {
  open: PanelId[];
  changesTab: 'changes' | 'files';
  /** Set once the tasks panel opened itself for this session's first background command. */
  tasksAutoOpened: boolean;
}

const EMPTY: SessionPanels = { open: [], changesTab: 'changes', tasksAutoOpened: false };

/** Mirrors --g-panel-width (measured) as the minimum; the default leaves room for a terminal. */
export const PANEL_MIN_WIDTH = 263;
export const PANEL_DEFAULT_WIDTH = 400;

interface PanelsState {
  bySession: Record<string, SessionPanels>;
  width: number;
  /** Panels widened to most of the window (the Background tasks expand button). */
  wide: boolean;
  browser: BrowserStateView | null;
  /** The last browser key the page passed on (find, the address bar); seq tells repeats apart. */
  browserShortcut: { name: 'find' | 'address'; seq: number } | null;
  toggle: (sessionId: string, panel: PanelId) => void;
  show: (sessionId: string, panel: PanelId) => void;
  close: (sessionId: string, panel: PanelId) => void;
  setChangesTab: (sessionId: string, tab: SessionPanels['changesTab']) => void;
  /** Opens the files view of the changes panel, or closes it when it's already showing. */
  toggleFiles: (sessionId: string) => void;
  markTasksAutoOpened: (sessionId: string) => void;
  setWidth: (width: number) => void;
  toggleWide: () => void;
  setBrowser: (state: BrowserStateView | null) => void;
  browserKey: (name: 'find' | 'address') => void;
}

export const usePanels = create<PanelsState>((set, get) => {
  const update = (sessionId: string, patch: (p: SessionPanels) => SessionPanels): void => {
    const current = get().bySession[sessionId] ?? EMPTY;
    set({ bySession: { ...get().bySession, [sessionId]: patch(current) } });
  };
  return {
    bySession: {},
    width: PANEL_DEFAULT_WIDTH,
    wide: false,
    browser: null,
    browserShortcut: null,
    toggle: (sessionId, panel) =>
      update(sessionId, (p) => ({ ...p, open: p.open.includes(panel) ? p.open.filter((x) => x !== panel) : [...p.open, panel] })),
    show: (sessionId, panel) => update(sessionId, (p) => (p.open.includes(panel) ? p : { ...p, open: [...p.open, panel] })),
    close: (sessionId, panel) => update(sessionId, (p) => ({ ...p, open: p.open.filter((x) => x !== panel) })),
    setChangesTab: (sessionId, tab) => update(sessionId, (p) => ({ ...p, changesTab: tab })),
    toggleFiles: (sessionId) =>
      update(sessionId, (p) =>
        p.open.includes('changes') && p.changesTab === 'files'
          ? { ...p, open: p.open.filter((x) => x !== 'changes') }
          : { ...p, changesTab: 'files', open: p.open.includes('changes') ? p.open : [...p.open, 'changes'] }
      ),
    markTasksAutoOpened: (sessionId) => update(sessionId, (p) => ({ ...p, tasksAutoOpened: true })),
    setWidth: (width) => set({ width, wide: false }),
    toggleWide: () => set({ wide: !get().wide }),
    setBrowser: (browser) => set({ browser }),
    browserKey: (name) => set({ browserShortcut: { name, seq: (get().browserShortcut?.seq ?? 0) + 1 } })
  };
});

export function panelsOf(state: Pick<PanelsState, 'bySession'>, sessionId: string): SessionPanels {
  return state.bySession[sessionId] ?? EMPTY;
}

/** Subscribers for terminal output, keyed by terminal id. */
const ptyListeners = new Map<string, Set<(data: string, offset: number) => void>>();
const ptyExitListeners = new Map<string, Set<(code: number) => void>>();
const shellListeners = new Map<string, Set<() => void>>();

function add<T>(map: Map<string, Set<T>>, key: string, fn: T): () => void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) map.delete(key);
  };
}

export const panelBus = {
  onPtyData: (id: string, fn: (data: string, offset: number) => void) => add(ptyListeners, id, fn),
  onPtyExit: (id: string, fn: (code: number) => void) => add(ptyExitListeners, id, fn),
  onShellsChanged: (sessionId: string, fn: () => void) => add(shellListeners, sessionId, fn),
  ptyData(id: string, data: string, offset: number): void {
    for (const fn of ptyListeners.get(id) ?? []) fn(data, offset);
  },
  ptyExit(id: string, code: number): void {
    for (const fn of ptyExitListeners.get(id) ?? []) fn(code);
  },
  shellsChanged(sessionId: string): void {
    for (const fn of shellListeners.get(sessionId) ?? []) fn();
  }
};
