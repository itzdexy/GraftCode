import { errorText, invoke } from '../../lib/ipc';
import { useEditorDrafts } from './editorDrafts';

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const writes = new Map<string, Promise<void>>();
let initialized = false;

/** Serialize each file's recovery writes, coalescing typing instead of storing every keypress. */
function backup(key: string): Promise<void> {
  const separator = key.indexOf(':');
  const sessionId = key.slice(0, separator), path = key.slice(separator + 1);
  const task = (writes.get(key) ?? Promise.resolve()).then(async () => {
    const draft = useEditorDrafts.getState().drafts[key];
    try {
      await invoke('files:backupDraft', { sessionId, path, draft: draft && draft.content !== draft.original ? draft : null });
      if (useEditorDrafts.getState().drafts[key] === draft) useEditorDrafts.setState((state) => ({ recovery: { ...state.recovery, [key]: { state: 'backed-up' } } }));
    } catch (error) {
      if (useEditorDrafts.getState().drafts[key] === draft) useEditorDrafts.setState((state) => ({ recovery: { ...state.recovery, [key]: { state: 'error', message: errorText(error) } } }));
    }
  });
  writes.set(key, task);
  void task.finally(() => { if (writes.get(key) === task) writes.delete(key); });
  return task;
}

export function initializeEditorRecovery(): void {
  if (initialized) return;
  initialized = true;
  useEditorDrafts.subscribe((state, previous) => {
    if (state.drafts === previous.drafts) return;
    for (const key of new Set([...Object.keys(state.drafts), ...Object.keys(previous.drafts)])) {
      if (state.drafts[key] === previous.drafts[key]) continue;
      const timer = timers.get(key); if (timer) clearTimeout(timer);
      useEditorDrafts.setState((s) => ({ recovery: { ...s.recovery, [key]: { state: 'pending' } } }));
      timers.set(key, setTimeout(() => { timers.delete(key); void backup(key); }, 250));
    }
  });
  window.addEventListener('beforeunload', () => { void flushEditorRecovery(); });
}

export async function flushEditorRecovery(sessionId?: string): Promise<void> {
  for (const [key, timer] of timers) {
    if (sessionId && !key.startsWith(`${sessionId}:`)) continue;
    clearTimeout(timer); timers.delete(key); void backup(key);
  }
  await Promise.all([...writes].filter(([key]) => !sessionId || key.startsWith(`${sessionId}:`)).map(([, task]) => task));
}

export async function recoverEditorDrafts(sessionId: string): Promise<void> {
  initializeEditorRecovery();
  await flushEditorRecovery(sessionId);
  const recovered = await invoke('files:drafts', { sessionId });
  useEditorDrafts.getState().restore(sessionId, recovered);
}
