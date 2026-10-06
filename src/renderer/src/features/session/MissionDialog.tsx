import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { PermissionMode } from '@shared/schemas/common';
import { MISSION_LIMITS } from '@shared/schemas/missions';
import { Button } from '../../components/Button';
import { Dialog, DialogContent } from '../../components/Dialog';
import { TextArea, TextField } from '../../components/Field';
import { errorText, invoke } from '../../lib/ipc';
import { linesOf, missionStartFrom, type MissionForm } from './missionModel';

interface Target {
  sessionId: string;
  /** The project, for the commands it suggests as checks; null when the session has no project folder. */
  projectPath: string | null;
  permissionMode: PermissionMode;
  /** What was typed after /mission, to start the objective with. */
  objective: string;
}

export const useMissionDialog = create<{ target: Target | null; open: (target: Target) => void; close: () => void }>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null })
}));

const MODE_HINT: Partial<Record<PermissionMode, string>> = {
  ask: 'This session is in Ask mode, so you approve each change and command. In Auto-edit or Auto the mission runs on its own.',
  plan: 'This session is in Plan mode, which only reads. Switch the mode, or approve the plan the agent proposes, for the mission to change files.'
};

function MissionForm({ target, onClose }: { target: Target; onClose: () => void }) {
  const [form, setForm] = useState<MissionForm>({ objective: target.objective, criteria: '', checks: '', maxTurns: String(MISSION_LIMITS.defaultTurns) });
  const [problem, setProblem] = useState<{ field: keyof MissionForm | 'start'; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  // Commands that look right for the project (its test, lint and type-check scripts), to add with one click.
  useEffect(() => {
    if (!target.projectPath) return;
    let cancelled = false;
    invoke('checks:get', { projectPath: target.projectPath })
      .then((view) => {
        if (!cancelled) setSuggestions(view.suggestions);
      })
      // The suggestions are a convenience: without them the commands are typed.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [target.projectPath]);

  const set = (patch: Partial<MissionForm>): void => {
    setForm((current) => ({ ...current, ...patch }));
    setProblem(null);
  };
  const chosen = linesOf(form.checks);
  const offered = suggestions.filter((command) => !chosen.includes(command));

  const start = async (): Promise<void> => {
    const result = missionStartFrom(form);
    if (!result.ok) {
      setProblem({ field: result.field, message: result.message });
      return;
    }
    setBusy(true);
    try {
      await invoke('sessions:startMission', { id: target.sessionId, ...result.start });
      onClose();
    } catch (error) {
      setProblem({ field: 'start', message: errorText(error) });
    } finally {
      setBusy(false);
    }
  };
  const errorFor = (field: keyof MissionForm): string | null => (problem?.field === field ? problem.message : null);
  const hint = MODE_HINT[target.permissionMode];

  return (
    <DialogContent
      title="Start a mission"
      description="Graft keeps working on the objective, turn after turn, and keeps a notebook as it goes. It counts as done only when the checks pass."
      className="w-[min(560px,calc(100vw-48px))]"
      hideClose={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void start()} disabled={busy || form.objective.trim().length === 0}>
            {busy ? 'Starting…' : 'Start mission'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-14"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <div className="flex flex-col gap-4">
          <TextArea
            label="Objective"
            value={form.objective}
            autoFocus
            rows={3}
            maxLength={MISSION_LIMITS.objective}
            placeholder="What should be true when this is finished?"
            aria-invalid={errorFor('objective') ? true : undefined}
            onChange={(event) => set({ objective: event.target.value })}
          />
          {errorFor('objective') ? (
            <p role="alert" className="text-sm text-danger">
              {errorFor('objective')}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-4">
          <TextArea
            label="Done means (optional)"
            value={form.criteria}
            rows={3}
            placeholder={'One per line, for example:\nFive failed logins lock the account for a minute'}
            aria-invalid={errorFor('criteria') ? true : undefined}
            onChange={(event) => set({ criteria: event.target.value })}
          />
          {errorFor('criteria') ? (
            <p role="alert" className="text-sm text-danger">
              {errorFor('criteria')}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-4">
          <TextArea
            label="Must pass (optional)"
            value={form.checks}
            rows={2}
            spellCheck={false}
            className="font-mono text-sm"
            placeholder={'One command per line, for example:\nnpm test'}
            aria-invalid={errorFor('checks') ? true : undefined}
            onChange={(event) => set({ checks: event.target.value })}
          />
          {errorFor('checks') ? (
            <p role="alert" className="text-sm text-danger">
              {errorFor('checks')}
            </p>
          ) : (
            <p className="text-sm text-fg-muted">
              Graft runs these itself when the agent reports the mission done, and sends back what fails. The agent can’t change them. Without any, the mission ends on the agent’s word.
            </p>
          )}
          {offered.length > 0 ? (
            <div className="flex flex-wrap items-center gap-6">
              <span className="text-sm text-fg-muted">From this project:</span>
              {offered.map((command) => (
                <button
                  key={command}
                  type="button"
                  onClick={() => set({ checks: [...chosen, command].join('\n') })}
                  className="h-22 rounded-sm border border-chip-edge bg-control px-6 font-mono text-2xs text-fg-secondary transition-ui hover:text-fg"
                >
                  + {command}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <TextField
          label="Turn limit"
          value={form.maxTurns}
          inputMode="numeric"
          className="max-w-[160px]"
          error={errorFor('maxTurns')}
          hint="The mission pauses here; you can let it go on."
          onChange={(event) => set({ maxTurns: event.target.value })}
        />

        {hint ? <p className="text-sm text-amber-fg">{hint}</p> : null}
        {problem?.field === 'start' ? (
          <p role="alert" className="text-sm text-danger">
            {problem.message}
          </p>
        ) : null}
        {/* Enter in a single-line field submits the form. */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </DialogContent>
  );
}

/** The dialog that starts a mission in a code session. Opened by /mission, the command palette and the mission bar. */
export function MissionDialog() {
  const target = useMissionDialog((s) => s.target);
  const close = useMissionDialog((s) => s.close);
  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : close())}>
      {target ? <MissionForm key={target.sessionId} target={target} onClose={close} /> : null}
    </Dialog>
  );
}
