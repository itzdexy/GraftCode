import type { SessionSummary } from '@shared/schemas/sessions';
import { invoke } from '../../lib/ipc';
import { useNav } from '../../stores/nav';
import { useToasts, reportError } from '../../stores/toasts';

/** Row-menu actions shared by the sidebar, home lists and the session header. */

export async function renameSession(id: string, title: string): Promise<void> {
  const trimmed = title.trim();
  if (trimmed.length === 0) return;
  try {
    await invoke('sessions:rename', { id, title: trimmed });
  } catch (error) {
    reportError("Couldn't rename the session", error);
  }
}

export async function setPinned(session: SessionSummary, pinned: boolean): Promise<void> {
  try {
    await invoke('sessions:setPinned', { id: session.id, pinned });
  } catch (error) {
    reportError(pinned ? "Couldn't pin the session" : "Couldn't unpin the session", error);
  }
}

export async function duplicateSession(session: SessionSummary): Promise<void> {
  try {
    const copy = await invoke('sessions:duplicate', { id: session.id });
    useNav.getState().go({ name: 'session', id: copy.id });
  } catch (error) {
    reportError("Couldn't duplicate the session", error);
  }
}

export async function exportSession(session: SessionSummary, format: 'markdown' | 'json'): Promise<void> {
  try {
    const saved = await invoke('sessions:export', { id: session.id, format });
    if (!saved) return;
    useToasts.getState().push({
      tone: 'success',
      title: 'Session exported',
      description: saved,
      action: {
        label: 'Show in folder',
        run: () => {
          invoke('app:revealPath', { path: saved }).catch((error: unknown) => reportError("Couldn't open the folder", error));
        }
      }
    });
  } catch (error) {
    reportError("Couldn't export the session", error);
  }
}

export async function unarchiveSession(session: SessionSummary): Promise<void> {
  try {
    await invoke('sessions:archive', { id: session.id, archived: false, removeWorktree: false, force: false });
  } catch (error) {
    reportError("Couldn't restore the session", error);
  }
}
