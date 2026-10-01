import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, EllipsisVertical, Pencil, Play, Plus, Trash } from 'lucide-react';
import type { PermissionMode } from '@shared/schemas/common';
import type { ScheduleInputView, ScheduleView } from '@shared/schemas/workspace';
import { Badge } from '../../components/Badge';
import { Button, IconButton } from '../../components/Button';
import { Dialog, DialogContent } from '../../components/Dialog';
import { Checkbox, TextArea, TextField } from '../../components/Field';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../components/Menu';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { cn } from '../../lib/cn';
import { onChanged } from '../../lib/bus';
import { PERMISSION_MODE_INFO, relativeTime, shortenPath } from '../../lib/format';
import { errorText, invoke } from '../../lib/ipc';
import { useLoad } from '../../lib/useLoad';
import { useApp } from '../../stores/app';
import { useNav } from '../../stores/nav';
import { reportError, useToasts } from '../../stores/toasts';
import { allModelsOf } from '../models/modelChoice';
import { PageLayout } from '../shell/PageLayout';

type Preset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MODES: PermissionMode[] = ['ask', 'auto-edit', 'plan', 'auto'];

/** Builds a cron expression from the friendly picker. */
export function cronFor(preset: Preset, time: string, weekday: number, minute: number, custom: string): string {
  const [h = '9', m = '0'] = time.split(':');
  const hh = Number(h);
  const mm = Number(m);
  switch (preset) {
    case 'hourly':
      return `${minute} * * * *`;
    case 'daily':
      return `${mm} ${hh} * * *`;
    case 'weekdays':
      return `${mm} ${hh} * * 1-5`;
    case 'weekly':
      return `${mm} ${hh} * * ${weekday}`;
    case 'custom':
      return custom.trim();
  }
}

function presetFrom(cron: string): { preset: Preset; time: string; weekday: number; minute: number } {
  const parts = cron.trim().split(/\s+/);
  const [m = '0', h = '9', dom = '*', mon = '*', dow = '*'] = parts;
  const time = `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  const numeric = (v: string): boolean => /^\d+$/.test(v);
  if (parts.length === 5 && dom === '*' && mon === '*') {
    if (numeric(m) && h === '*' && dow === '*') return { preset: 'hourly', time: '09:00', weekday: 1, minute: Number(m) };
    if (numeric(m) && numeric(h) && dow === '*') return { preset: 'daily', time, weekday: 1, minute: 0 };
    if (numeric(m) && numeric(h) && dow === '1-5') return { preset: 'weekdays', time, weekday: 1, minute: 0 };
    if (numeric(m) && numeric(h) && numeric(dow)) return { preset: 'weekly', time, weekday: Number(dow) % 7, minute: 0 };
  }
  return { preset: 'custom', time: '09:00', weekday: 1, minute: 0 };
}

function EditDialog({ schedule, onClose, onSaved }: { schedule: ScheduleView | null; onClose: () => void; onSaved: () => void }) {
  const projects = useApp((s) => s.projects);
  const groups = useApp((s) => s.models);
  const models = useMemo(() => allModelsOf(groups), [groups]);
  const initial = presetFrom(schedule?.cron ?? '0 9 * * 1-5');
  const [name, setName] = useState(schedule?.name ?? '');
  const [prompt, setPrompt] = useState(schedule?.prompt ?? '');
  const [projectPath, setProjectPath] = useState(schedule?.projectPath ?? projects.find((p) => p.exists)?.path ?? '');
  const [preset, setPreset] = useState<Preset>(initial.preset);
  const [time, setTime] = useState(initial.time);
  const [weekday, setWeekday] = useState(initial.weekday);
  const [minute, setMinute] = useState(initial.minute);
  const [custom, setCustom] = useState(schedule?.cron ?? '0 9 * * 1-5');
  const [modelKey, setModelKey] = useState(schedule?.providerId && schedule.modelId ? `${schedule.providerId}\u0000${schedule.modelId}` : '');
  const [mode, setMode] = useState<PermissionMode>(schedule?.permissionMode ?? 'auto');
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [preview, setPreview] = useState<{ description: string; next: number | null; error: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cron = cronFor(preset, time, weekday, minute, custom);

  useEffect(() => {
    let cancelled = false;
    invoke('schedules:describe', { cron })
      .then((p) => {
        if (!cancelled) setPreview(p);
      })
      .catch((e: unknown) => {
        if (!cancelled) setPreview({ description: cron, next: null, error: errorText(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [cron]);

  const save = async (): Promise<void> => {
    const model = models.find((m) => `${m.ref.providerId}\u0000${m.ref.modelId}` === modelKey) ?? null;
    const input: ScheduleInputView = {
      name,
      cron,
      prompt,
      projectPath,
      providerId: model?.ref.providerId ?? null,
      modelId: model?.ref.modelId ?? null,
      effort: null,
      permissionMode: mode,
      enabled
    };
    setBusy(true);
    setError(null);
    try {
      await invoke('schedules:save', { id: schedule?.id ?? null, schedule: input });
      onSaved();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const select = 'h-32 w-full rounded-md border border-input-border bg-input px-8 text-base text-fg outline-none focus:border-border-strong';
  return (
    <DialogContent
      title={schedule ? 'Edit schedule' : 'New schedule'}
      description="Graft starts a new session with this prompt at each scheduled time, while the app is open."
      className="w-[min(560px,calc(100vw-48px))]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || !name.trim() || !prompt.trim() || !projectPath || preview?.error !== null}>
            {schedule ? 'Save' : 'Create schedule'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-12">
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly test run" maxLength={120} autoFocus />
        <TextArea label="What should the session do?" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="Run the test suite and summarize any failures with likely causes." />
        <label className="flex flex-col gap-6 text-base font-medium text-fg-secondary">
          Folder
          <select className={select} value={projectPath} onChange={(e) => setProjectPath(e.target.value)}>
            {projects.length === 0 ? <option value="">Add a project first</option> : null}
            {projects.map((p) => (
              <option key={p.id} value={p.path}>
                {p.name} — {shortenPath(p.path, 48)}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="flex flex-col gap-6">
          <legend className="mb-6 text-base font-medium text-fg-secondary">When</legend>
          <div role="radiogroup" aria-label="Repeat" className="flex flex-wrap gap-6">
            {(['hourly', 'daily', 'weekdays', 'weekly', 'custom'] as const).map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={preset === p}
                onClick={() => setPreset(p)}
                className={cn('h-26 rounded-md border px-10 text-base', preset === p ? 'border-toggle-thumb-border bg-toggle-thumb text-fg-strong' : 'border-border text-fg-secondary hover:bg-hover')}
              >
                {{ hourly: 'Every hour', daily: 'Every day', weekdays: 'Weekdays', weekly: 'Weekly', custom: 'Custom' }[p]}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-8">
            {preset === 'hourly' ? (
              <label className="flex items-center gap-6 text-base text-fg-secondary">
                at minute
                <input type="number" min={0} max={59} value={minute} onChange={(e) => setMinute(Math.min(59, Math.max(0, Number(e.target.value))))} className={cn(select, 'w-72')} />
              </label>
            ) : null}
            {preset === 'weekly' ? (
              <select aria-label="Day" className={cn(select, 'w-160')} value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                {DAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            ) : null}
            {preset === 'daily' || preset === 'weekdays' || preset === 'weekly' ? (
              <input type="time" aria-label="Time" value={time} onChange={(e) => setTime(e.target.value)} className={cn(select, 'w-120')} />
            ) : null}
            {preset === 'custom' ? (
              <TextField aria-label="Cron expression" value={custom} onChange={(e) => setCustom(e.target.value)} inputClassName="font-mono" hint="minute hour day-of-month month day-of-week" className="flex-1" />
            ) : null}
          </div>
          {preview ? (
            <p className={cn('text-sm', preview.error ? 'text-danger' : 'text-fg-muted')}>
              {preview.error ?? `${preview.description}${preview.next ? ` · next run ${new Date(preview.next).toLocaleString()}` : ''}`}
            </p>
          ) : null}
        </fieldset>
        <div className="grid grid-cols-2 gap-8">
          <label className="flex flex-col gap-6 text-base font-medium text-fg-secondary">
            Model
            <select className={select} value={modelKey} onChange={(e) => setModelKey(e.target.value)}>
              <option value="">Default model</option>
              {models.map((m) => (
                <option key={`${m.ref.providerId}/${m.ref.modelId}`} value={`${m.ref.providerId}\u0000${m.ref.modelId}`}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-6 text-base font-medium text-fg-secondary">
            Permissions
            <select className={select} value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {PERMISSION_MODE_INFO[m].label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="text-sm text-fg-muted">Anything that needs approval waits for you and sends a notification.</p>
        <Checkbox label="Enabled" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {error ? (
          <p role="alert" className="text-base text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </DialogContent>
  );
}

function ScheduleRow({ schedule, onEdit, onChange }: { schedule: ScheduleView; onEdit: () => void; onChange: () => void }) {
  const { load } = useLoad(() => invoke('schedules:runs', { id: schedule.id }), `${schedule.id}:${schedule.lastRunAt ?? 0}`);
  const last = load.status === 'ready' ? load.data[0] : undefined;
  const act = (label: string, run: () => Promise<unknown>): void => {
    run()
      .then(onChange)
      .catch((e: unknown) => reportError(label, e));
  };
  return (
    <li className="flex min-h-[56px] items-center gap-12 rounded-md bg-raised px-12 py-8">
      <CalendarClock className={cn('size-16 shrink-0', schedule.enabled ? 'text-icon' : 'text-icon-muted')} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-8">
          <span className="truncate text-base font-medium text-fg-strong">{schedule.name}</span>
          {schedule.enabled ? null : <Badge>Paused</Badge>}
        </div>
        <p className="truncate text-sm text-fg-muted">
          {schedule.description} · {shortenPath(schedule.projectPath, 40)}
          {schedule.enabled && schedule.nextRunAt ? ` · next ${new Date(schedule.nextRunAt).toLocaleString()}` : ''}
        </p>
        {last ? (
          <button
            type="button"
            disabled={!last.sessionId}
            onClick={() => last.sessionId && useNav.getState().go({ name: 'session', id: last.sessionId })}
            className="text-sm text-link hover:underline disabled:text-fg-faint disabled:no-underline"
          >
            Last run {relativeTime(last.startedAt)}: {{ running: 'running', waiting: 'needs input', completed: 'done', failed: 'failed' }[last.status]}
            {last.error ? ` — ${last.error}` : ''}
          </button>
        ) : null}
      </div>
      <Button size="sm" variant="secondary" leading={<Play className="size-12" />} onClick={() => act("Couldn't start the run", () => invoke('schedules:runNow', { id: schedule.id }))}>
        Run now
      </Button>
      <Menu>
        <MenuTrigger asChild>
          <IconButton label={`Options for ${schedule.name}`}>
            <EllipsisVertical className="size-16" />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem icon={<Pencil className="size-14" />} onSelect={onEdit}>
            Edit…
          </MenuItem>
          <MenuItem onSelect={() => act("Couldn't update the schedule", () => invoke('schedules:setEnabled', { id: schedule.id, enabled: !schedule.enabled }))}>
            {schedule.enabled ? 'Pause' : 'Resume'}
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger icon={<Trash className="size-14 text-danger" />} onSelect={() => act("Couldn't delete the schedule", () => invoke('schedules:delete', { id: schedule.id }))}>
            Delete
          </MenuItem>
        </MenuContent>
      </Menu>
    </li>
  );
}

/** Recurring sessions that the app starts on a schedule while it is open. */
export function ScheduledView() {
  const { load, reload } = useLoad(() => invoke('schedules:list'), 'schedules');
  const [editing, setEditing] = useState<ScheduleView | 'new' | null>(null);
  useEffect(() => onChanged('schedules', reload), [reload]);
  const hasProjects = useApp((s) => s.projects.length > 0);

  return (
    <PageLayout
      title="Scheduled"
      description="Sessions Graft starts on a schedule while it's open. Missed times are skipped."
      actions={
        <Button variant="secondary" leading={<Plus className="size-14" />} onClick={() => setEditing('new')} disabled={!hasProjects}>
          New schedule
        </Button>
      }
    >
      {load.status === 'loading' ? <LoadingState /> : null}
      {load.status === 'error' ? <ErrorState message={load.message} onRetry={reload} /> : null}
      {load.status === 'ready' && load.data.length === 0 ? (
        <EmptyState
          icon={<CalendarClock className="size-20" />}
          title="Nothing scheduled"
          description={hasProjects ? 'Run a prompt every morning, every hour, or on any cron schedule.' : 'Add a project folder first; scheduled sessions run in a folder.'}
        />
      ) : null}
      {load.status === 'ready' ? (
        <ul className="flex flex-col gap-[var(--g-session-row-gap)]">
          {load.data.map((s) => (
            <ScheduleRow key={s.id} schedule={s} onEdit={() => setEditing(s)} onChange={reload} />
          ))}
        </ul>
      ) : null}
      <Dialog open={editing !== null} onOpenChange={(open) => (open ? undefined : setEditing(null))}>
        {editing ? (
          <EditDialog
            key={editing === 'new' ? 'new' : editing.id}
            schedule={editing === 'new' ? null : editing}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              reload();
              useToasts.getState().push({ tone: 'success', title: 'Schedule saved' });
            }}
          />
        ) : null}
      </Dialog>
    </PageLayout>
  );
}
