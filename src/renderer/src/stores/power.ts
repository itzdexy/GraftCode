import { create } from 'zustand';
import { invoke } from '../lib/ipc';
import { reportError } from './toasts';

/** Sessions that keep the computer awake while they work (lasts until Graft quits). */
interface PowerState {
  keepAwake: string[] | null;
  load: () => void;
  setKeepAwake: (sessionId: string, on: boolean) => void;
}

export const usePower = create<PowerState>((set, get) => ({
  keepAwake: null,

  load: () => {
    if (get().keepAwake) return;
    invoke('power:keepAwakeList')
      .then((ids) => set({ keepAwake: ids }))
      .catch((error: unknown) => reportError("Couldn't read the keep-awake setting", error));
  },

  setKeepAwake: (sessionId, on) => {
    const current = get().keepAwake ?? [];
    set({ keepAwake: on ? [...new Set([...current, sessionId])] : current.filter((id) => id !== sessionId) });
    invoke('power:keepAwake', { sessionId, on }).catch((error: unknown) => {
      set({ keepAwake: current });
      reportError("Couldn't change keep-awake", error);
    });
  }
}));
