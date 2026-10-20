import { create } from 'zustand';

/** The session shown beside the open one (split view), and which pane the keyboard belongs to. */

/** Narrower than this the side pane is not useful; wider than this it swallows the main one. */
export const SIDE_MIN = 320;
export const DEFAULT_SIDE_WIDTH = 520;

interface PanesState {
  /** The session on the right; null when there is no split. */
  side: string | null;
  /** The pane that answers the keyboard: the main one, or the one beside it. */
  focus: 'main' | 'side';
  /** Width of the side pane in pixels. Kept for this run of the app. */
  width: number;
  /** Opens a session beside the open one; it takes the keyboard, like opening it normally would. */
  open: (id: string) => void;
  close: () => void;
  setFocus: (focus: 'main' | 'side') => void;
  setWidth: (width: number) => void;
}

export const usePanes = create<PanesState>((set) => ({
  side: null,
  focus: 'main',
  width: DEFAULT_SIDE_WIDTH,
  open: (side) => set({ side, focus: 'side' }),
  close: () => set({ side: null, focus: 'main' }),
  setFocus: (focus) => set({ focus }),
  setWidth: (width) => set({ width: Math.max(SIDE_MIN, Math.round(width)) })
}));

/**
 * True while the keyboard belongs to this pane. Without a split it always does;
 * with one, only the focused pane answers window shortcuts (Ctrl+`, Ctrl+F, Esc)
 * so a key does not act on both sessions at once.
 */
export function paneActive(side: string | null, focus: 'main' | 'side', pane: 'main' | 'side'): boolean {
  return side === null || focus === pane;
}

export function usePaneActive(pane: 'main' | 'side'): boolean {
  return usePanes((s) => paneActive(s.side, s.focus, pane));
}
