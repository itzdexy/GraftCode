import { useState, useSyncExternalStore } from 'react';
import { Check, ChevronRight, Circle, Copy, Pause, Play, Square, Target, X } from 'lucide-react';
import { MISSION_LIMITS, missionOpen, type Mission } from '@shared/schemas/missions';
import { Badge } from '../../components/Badge';
import { Button, IconButton } from '../../components/Button';
import { Collapse } from '../../components/Collapse';
import { Ring } from '../../components/ContextRing';
import { cn } from '../../lib/cn';
import { invoke } from '../../lib/ipc';
import { notify, reportError } from '../../stores/toasts';
import { ConfirmDialog } from '../settings/common';
import { missionMarkdown, missionStatusLine } from './missionModel';

// Finished missions the user closed the bar of: remembered on this computer, so they stay closed.
const DISMISSED_KEY = 'graft.missions.dismissed';
const listeners = new Set<() => void>();
let dismissedCache: string[] | null = null;

function dismissed(): string[] {
  if (dismissedCache) return dismissedCache;
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]');
    dismissedCache = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    dismissedCache = [];
  }
  return dismissedCache;
}

function dismiss(id: string): void {
  dismissedCache = [...dismissed().filter((x) => x !== id), id].slice(-200);
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissedCache));
  } catch {
    // Without storage it stays closed until Graft restarts.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function act(channel: 'sessions:pauseMission' | 'sessions:resumeMission' | 'sessions:cancelMission', sessionId: string, failure: string): void {
  invoke(channel, { id: sessionId }).catch((error: unknown) => reportError(failure, error));
}

function CheckState({ passed }: { passed: boolean | undefined }) {
  if (passed === undefined) return <Circle className="size-10 shrink-0 text-icon-muted" aria-label="Not run yet" />;
  return passed ? <Check className="size-12 shrink-0 text-success" aria-label="Passed" /> : <X className="size-12 shrink-0 text-danger" aria-label="Failed" />;
}

function Details({ mission }: { mission: Mission }) {
  const ran = new Map((mission.verification?.runs ?? []).map((run) => [run.command, run.passed]));
  const copy = (): void => {
    navigator.clipboard.writeText(missionMarkdown(mission)).then(
      () => notify('Mission copied as Markdown'),
      (error: unknown) => reportError("Couldn't copy to the clipboard", error)
    );
  };
  return (
    <div className="flex flex-col gap-10 border-t border-divider px-10 pt-8 pb-10 text-sm">
      <p className="selectable whitespace-pre-wrap text-fg">{mission.objective}</p>
      {mission.criteria.length > 0 ? (
        <section aria-label="Done means">
          <h4 className="text-2xs font-medium text-fg-muted">Done means</h4>
          <ul className="mt-2 flex list-disc flex-col gap-2 pl-16 text-fg-secondary">
            {mission.criteria.map((criterion) => (
              <li key={criterion} className="selectable">
                {criterion}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {mission.checks.length > 0 ? (
        <section aria-label="Must pass">
          <h4 className="text-2xs font-medium text-fg-muted">Must pass</h4>
          <ul className="mt-2 flex flex-col gap-2">
            {mission.checks.map((command) => (
              <li key={command} className="flex items-center gap-6">
                <CheckState passed={ran.get(command)} />
                <code className="selectable min-w-0 truncate font-mono text-2xs text-fg-secondary" title={command}>
                  {command}
                </code>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="text-fg-muted">No checks: the mission ends when the agent reports it done.</p>
      )}
      {mission.result ? (
        <section aria-label="Result">
          <h4 className="text-2xs font-medium text-fg-muted">{mission.status === 'done' ? 'Result' : 'Reported'}</h4>
          <p className="selectable mt-2 whitespace-pre-wrap text-fg-secondary">{mission.result}</p>
        </section>
      ) : null}
      <section aria-label="Notebook">
        <h4 className="text-2xs font-medium text-fg-muted">Notebook{mission.notebook.length > 0 ? ` · ${String(mission.notebook.length)}` : ''}</h4>
        {mission.notebook.length > 0 ? (
          <ul className="mt-2 flex max-h-[220px] flex-col gap-4 overflow-y-auto pr-4">
            {mission.notebook.map((note, i) => (
              <li key={i} className="flex items-start gap-6">
                <Badge tone={note.kind === 'blocker' ? 'warning' : 'neutral'}>{note.kind}</Badge>
                <span className="selectable min-w-0 flex-1 whitespace-pre-wrap text-fg-secondary">{note.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-fg-muted">Empty so far. The agent records what it finds and decides here, and gets it back every turn.</p>
        )}
      </section>
      <Button size="xs" variant="ghost" className="self-start" onClick={copy} leading={<Copy className="size-12" />}>
        Copy as Markdown
      </Button>
    </div>
  );
}

/**
 * The session's mission above the message box: what it is for, where it
 * stands, and the controls to pause, resume or stop it. Opens to show what
 * done means, the checks and the agent's notebook.
 */
export function MissionBar({ sessionId, mission, checking }: { sessionId: string; mission: Mission | null; checking: boolean }) {
  const closed = useSyncExternalStore(subscribe, dismissed);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  if (!mission) return null;
  const going = missionOpen(mission.status);
  if (!going && closed.includes(mission.id)) return null;
  const spent = mission.status === 'paused' && mission.turns >= mission.maxTurns;
  const working = mission.status === 'active';

  return (
    <section aria-label="Mission" className="motion-rise rounded-lg border border-border bg-raised">
      <div className="flex min-h-34 items-center gap-8 py-2 pr-4 pl-9">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-8 text-left text-base">
          {working ? <Ring value={mission.turns / Math.max(1, mission.maxTurns)} size={14} spinning={checking} label="Mission progress" /> : <Target className={cn('size-14 shrink-0', mission.status === 'done' ? 'text-success' : 'text-icon')} aria-hidden="true" />}
          <span className="shrink-0 font-medium text-fg">Mission</span>
          <span className="min-w-0 flex-1 truncate text-fg-muted" title={mission.objective}>
            {mission.objective}
          </span>
          <span className={cn('max-w-[46%] shrink-0 truncate text-sm tabular-nums', mission.status === 'paused' ? 'text-amber-fg' : mission.status === 'done' ? 'text-success' : 'text-fg-muted')} title={missionStatusLine(mission, checking)}>
            {missionStatusLine(mission, checking)}
          </span>
          <ChevronRight className={cn('size-12 shrink-0 text-icon-muted transition-transform', open && 'rotate-90')} aria-hidden="true" />
        </button>
        {mission.status === 'active' ? (
          <Button size="xs" variant="ghost" onClick={() => act('sessions:pauseMission', sessionId, "Couldn't pause the mission")} leading={<Pause className="size-10" />} title="Lets the turn that is running finish, then waits">
            Pause
          </Button>
        ) : null}
        {mission.status === 'paused' ? (
          <Button size="xs" variant="secondary" onClick={() => act('sessions:resumeMission', sessionId, "Couldn't resume the mission")} leading={<Play className="size-10" />}>
            {spent ? `Go on for ${String(MISSION_LIMITS.moreTurns)} more turns` : 'Resume'}
          </Button>
        ) : null}
        {going ? (
          <IconButton label="Stop the mission" size="xs" onClick={() => setConfirming(true)}>
            <Square className="size-10 fill-current" strokeWidth={0} />
          </IconButton>
        ) : (
          <IconButton label="Close" size="xs" onClick={() => dismiss(mission.id)}>
            <X className="size-14" />
          </IconButton>
        )}
      </div>
      <Collapse open={open}>
        <Details mission={mission} />
      </Collapse>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Stop this mission?"
        description="It ends here and can't be resumed, and the turn working on it stops. The changes made so far stay, and you can start a new mission."
        confirmLabel="Stop the mission"
        danger
        onConfirm={() => invoke('sessions:cancelMission', { id: sessionId }).then(() => undefined)}
      />
    </section>
  );
}
