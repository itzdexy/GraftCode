import { useEffect, useState } from 'react';
import { Mark } from '../../brand/Mark';
import { formatTokenCount } from '../../lib/format';
import { invoke } from '../../lib/ipc';
import { logError } from '../../lib/log';
import { subscribeVisibleClock } from '../../lib/motion';
import { panelBus, usePanels } from '../../stores/panels';
import { durationText } from './transcriptModel';

export const THINKING_VERBS = [
  'Thinking',
  'Weighing options',
  'Grafting',
  'Tending',
  'Pruning',
  'Cultivating',
  'Rooting around',
  'Sorting it out',
  'Planning',
  'Considering'
] as const;

const ROTATE_MS = 2400;

/** Background commands of a session that are still running; follows the shells panel's change events. */
function useRunningTasks(sessionId: string, enabled: boolean): number {
  const [running, setRunning] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const load = (): void => {
      invoke('shells:list', { sessionId })
        .then((shells) => current && setRunning(shells.filter((s) => s.status === 'running').length))
        .catch((error: unknown) => logError('Could not list background commands', error));
    };
    load();
    const off = panelBus.onShellsChanged(sessionId, load);
    return () => {
      current = false;
      off();
    };
  }, [sessionId, enabled]);
  return running;
}

/**
 * Under a running turn: Scion at work, the time so far, the size of the
 * context, background commands still running (opens their panel) and a
 * rotating verb.
 */
export function StatusLine({ sessionId, startedAt, contextTokens, tasks }: { sessionId: string; startedAt: number | null; contextTokens: number; tasks: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribeVisibleClock(() => setNow(Date.now())), []);
  const running = useRunningTasks(sessionId, tasks);
  const elapsed = startedAt === null ? 0 : Math.max(0, now - startedAt);
  const verb = THINKING_VERBS[Math.floor(elapsed / ROTATE_MS) % THINKING_VERBS.length] ?? THINKING_VERBS[0];
  return (
    <div className="motion-rise flex min-w-0 flex-wrap items-center gap-x-8 gap-y-4 py-4 text-md text-fg-muted">
      <span role="status" className="sr-only">
        Graft is working
      </span>
      <Mark size={18} motion="thinking" />
      {startedAt === null ? null : (
        <span className="text-sm text-fg-faint tabular-nums" aria-hidden="true">
          {durationText(elapsed)}
        </span>
      )}
      {contextTokens > 0 ? (
        <span className="text-sm text-fg-faint" aria-hidden="true">
          · {formatTokenCount(contextTokens)} tokens
        </span>
      ) : null}
      {tasks && running > 0 ? (
        <>
          <span className="text-sm text-fg-faint" aria-hidden="true">
            ·
          </span>
          <button type="button" onClick={() => usePanels.getState().show(sessionId, 'tasks')} className="text-sm text-link hover:underline">
            {running === 1 ? '1 running task' : `${String(running)} running tasks`}
          </button>
        </>
      ) : null}
      <span key={verb} className="graft-verb inline-block min-w-[114px] text-sm text-fg-muted" aria-hidden="true">
        · {verb}…
      </span>
    </div>
  );
}
