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

/** Marks a session as completed, so it leaves the working lists, or as in progress again. Undo is one click. */
export async function setCompleted(session: SessionSummary, completed: boolean): Promise<void> {
  try {
    await invoke('sessions:setCompleted', { id: session.id, completed });
    useToasts.getState().push({
      tone: 'success',
      title: completed ? 'Marked as completed' : 'Marked as in progress',
      action: { label: 'Undo', run: () => void setCompleted(session, !completed) }
    });
  } catch (error) {
    reportError(completed ? "Couldn't mark the session as completed" : "Couldn't mark the session as in progress", error);
  }
}

/** Files a session under a group; null takes it out of every group. */
export async function setSessionGroup(session: SessionSummary, groupId: string | null): Promise<void> {
  try {
    await invoke('sessions:setGroup', { id: session.id, groupId });
  } catch (error) {
    reportError(groupId === null ? "Couldn't take the session out of its group" : "Couldn't move the session into that group", error);
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
