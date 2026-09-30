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
}

let seq = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push(toast) {
    const id = ++seq;
    set({ toasts: [...get().toasts, { ...toast, id }].slice(-4) });
    timers.set(
      id,
      setTimeout(() => get().dismiss(id), toast.tone === 'error' ? 10_000 : 5_000)
    );
    return id;
  },
  dismiss(id) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  }
}));

/** Shows a failed action to the user; every caught renderer error goes through here or inline UI. */
export function reportError(title: string, error: unknown): void {
  useToasts.getState().push({ tone: 'error', title, description: errorText(error) });
}

export function notify(title: string, description?: string): void {
  useToasts.getState().push({ tone: 'info', title, ...(description ? { description } : {}) });
}
