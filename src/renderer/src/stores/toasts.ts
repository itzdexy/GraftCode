import { create } from 'zustand';
import { errorText } from '../lib/ipc';

export interface Toast {
  id: number;
  tone: 'info' | 'success' | 'error';
  title: string;
  description?: string;
  action?: { label: string; run: () => void };
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id'>) => number;
  dismiss: (id: number) => void;
  /** The pointer is on the toasts: none of them goes away until `release`. */
  hold: () => void;
  release: () => void;
}

/** After the pointer leaves, a toast stays at least this long. */
const GRACE_MS = 1_500;

let seq = 0;
let held = false;
/** Each toast's countdown: the running timer and when it ends, or the time left while held. */
const lives = new Map<number, { timer: ReturnType<typeof setTimeout> | null; endsAt: number; left: number }>();

function start(id: number, ms: number): void {
  const previous = lives.get(id);
  if (previous?.timer) clearTimeout(previous.timer);
  lives.set(id, { timer: setTimeout(() => useToasts.getState().dismiss(id), ms), endsAt: Date.now() + ms, left: ms });
}

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push(toast) {
    const id = ++seq;
    set({ toasts: [...get().toasts, { ...toast, id }].slice(-4) });
    const life = toast.tone === 'error' ? 10_000 : 5_000;
    if (held) lives.set(id, { timer: null, endsAt: 0, left: life });
    else start(id, life);
    return id;
  },
  dismiss(id) {
    const life = lives.get(id);
    if (life?.timer) clearTimeout(life.timer);
    lives.delete(id);
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
  hold() {
    if (held) return;
    held = true;
    for (const [id, life] of lives) {
      if (!life.timer) continue;
      clearTimeout(life.timer);
      lives.set(id, { timer: null, endsAt: 0, left: Math.max(0, life.endsAt - Date.now()) });
    }
  },
  release() {
    if (!held) return;
    held = false;
    for (const [id, life] of lives) start(id, Math.max(GRACE_MS, life.left));
  }
}));

/** Shows a failed action to the user; every caught renderer error goes through here or inline UI. */
export function reportError(title: string, error: unknown): void {
  useToasts.getState().push({ tone: 'error', title, description: errorText(error) });
}

export function notify(title: string, description?: string): void {
  useToasts.getState().push({ tone: 'info', title, ...(description ? { description } : {}) });
}
