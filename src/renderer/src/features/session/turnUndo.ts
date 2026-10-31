import { create } from 'zustand';
import { invoke } from '../../lib/ipc';
import { reportError, useToasts } from '../../stores/toasts';

/**
 * What has been undone on the file cards of past turns: a whole file (put back
 * from its turn's snapshot) or one change of it (one hunk of one edit).
 */

/** A file of a turn, by the message that started the turn. */
export const fileUndoKey = (sessionId: string, messageId: string, path: string): string => `${sessionId}:${messageId}:${path}`;
/** One hunk of one edit, by the call that made the edit. */
export const hunkUndoKey = (sessionId: string, callId: string, hunk: number): string => `${sessionId}:${callId}:${String(hunk)}`;

interface TurnUndoState {
  undone: Record<string, true>;
  /** Hunks being undone right now. */
  busy: Record<string, true>;
  mark: (keys: string[]) => void;
}

/** rocky: kept while the window is open; after a restart the cards offer Undo again, and undoing a hunk twice is refused because its lines are gone. */
export const useTurnUndo = create<TurnUndoState>((set) => ({
  undone: {},
  busy: {},
  mark: (keys) => set((state) => ({ undone: { ...state.undone, ...Object.fromEntries(keys.map((key) => [key, true as const])) } }))
}));

/** Takes one change of a turn back out of its file, and says so; a change that can't be undone says why. */
export async function undoHunk(sessionId: string, callId: string, hunk: number, name: string): Promise<void> {
  const key = hunkUndoKey(sessionId, callId, hunk);
  if (useTurnUndo.getState().busy[key]) return;
  useTurnUndo.setState((state) => ({ busy: { ...state.busy, [key]: true } }));
  try {
    await invoke('sessions:undoHunk', { sessionId, toolUseId: callId, hunk });
    useTurnUndo.getState().mark([key]);
    useToasts.getState().push({ tone: 'success', title: 'Change undone', description: `The rest of ${name} is as it was.` });
  } catch (error) {
    reportError("Couldn't undo the change", error);
  } finally {
    useTurnUndo.setState((state) => {
      const { [key]: _done, ...busy } = state.busy;
      return { busy };
    });
  }
}
