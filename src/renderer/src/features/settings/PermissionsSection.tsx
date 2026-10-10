import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { PermissionMode } from '@shared/schemas/common';
import type { SettingsScope } from '@shared/schemas/config';
import type { RuleLists, ScopedRules } from '@shared/schemas/system';
import { Button, IconButton } from '../../components/Button';
import { Switch } from '../../components/Field';
import { ErrorState, LoadingState } from '../../components/States';
import { cn } from '../../lib/cn';
import { PERMISSION_MODE_INFO } from '../../lib/format';
import { errorText, invoke } from '../../lib/ipc';
import { useLoad } from '../../lib/useLoad';
import { useApp } from '../../stores/app';
import { useToasts } from '../../stores/toasts';
import { ConfirmDialog, Group, saveSettings, SettingRow } from './common';
import { ProjectPicker } from './ProjectPicker';

/** Choices for Steps per turn (besides no limit). */
const STEP_LIMITS = [100, 250, 500, 1000, 2500] as const;
/** Choices for the limits of one turn (besides no limit): tokens, US dollars, minutes. */
const TOKEN_LIMITS = [250_000, 1_000_000, 5_000_000, 20_000_000] as const;
const COST_LIMITS = [1, 5, 10, 25, 100] as const;
const MINUTE_LIMITS = [10, 30, 60, 180] as const;

const dollars = (n: number): string => `$${Number.isInteger(n) ? String(n) : n.toFixed(2)}`;
const duration = (minutes: number): string =>
  minutes % 60 !== 0 ? `${String(minutes)} minutes` : minutes === 60 ? '1 hour' : `${String(minutes / 60)} hours`;

/** A limit picked from a few values, or none. A stored value that isn't one of them is listed too, so it is never shown as something else. */
function LimitSelect({ label, value, choices, format, onChange }: { label: string; value: number | null; choices: readonly number[]; format: (n: number) => string; onChange: (value: number | null) => void }) {
  const listed = value === null || choices.includes(value) ? choices : [...choices, value].sort((a, b) => a - b);
  return (
    <select
      aria-label={label}
      className="h-28 rounded-md border border-input-border bg-input px-8 text-base text-fg outline-none focus:border-border-strong"
      value={value === null ? 'none' : String(value)}
      onChange={(e) => onChange(e.target.value === 'none' ? null : Number(e.target.value))}
    >
      <option value="none">No limit</option>
      {listed.map((n) => (
        <option key={n} value={String(n)}>
          {format(n)}
        </option>
      ))}
    </select>
  );
}

const KINDS: Array<{ kind: keyof RuleLists; title: string; help: string }> = [
  { kind: 'allow', title: 'Allow', help: 'Runs without asking.' },
  { kind: 'ask', title: 'Ask', help: 'Always asks, even in Auto modes.' },
  { kind: 'deny', title: 'Deny', help: 'Never runs.' }
];

const SCOPE_INFO: Record<SettingsScope, { label: string; description: string }> = {
  user: { label: 'All projects', description: 'Your rules, applied everywhere.' },
  project: { label: 'Project (shared)', description: 'Saved in .graft/settings.json and shared with everyone who uses the repository.' },
  local: { label: 'Project (this computer)', description: 'Saved in .graft/settings.local.json, which stays on this computer.' }
};

/** Editable allow / ask / deny lists of one settings file. */
function RulesEditor({ scoped, projectPath, onSaved }: { scoped: ScopedRules; projectPath: string | null; onSaved: () => void }) {
  const [draft, setDraft] = useState<RuleLists>({ allow: scoped.allow, ask: scoped.ask, deny: scoped.deny });
  const [inputs, setInputs] = useState<Record<keyof RuleLists, string>>({ allow: '', ask: '', deny: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = KINDS.some(({ kind }) => draft[kind].join('\n') !== scoped[kind].join('\n'));
  const readOnly = scoped.error !== null;

  const add = (kind: keyof RuleLists): void => {
    const rule = inputs[kind].trim();
    if (!rule) return;
    if (!draft[kind].includes(rule)) setDraft({ ...draft, [kind]: [...draft[kind], rule] });
    setInputs({ ...inputs, [kind]: '' });
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await invoke('permissions:save', { scope: scoped.scope, projectPath, rules: draft });
      useToasts.getState().push({ tone: 'success', title: 'Rules saved' });
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group
      title={SCOPE_INFO[scoped.scope].label}
      description={
        <>
          {SCOPE_INFO[scoped.scope].description} <span className="selectable font-mono text-xs">{scoped.path}</span>
        </>
      }
    >
      {scoped.error ? (
        <p role="alert" className="px-14 py-10 text-sm text-danger">
          {scoped.error}
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-12 px-14 py-12 min-[900px]:grid-cols-3">
        {KINDS.map(({ kind, title, help }) => (
          <div key={kind} className="flex min-w-0 flex-col gap-6">
            <p className="text-base font-medium text-fg-secondary">
              {title} <span className="font-normal text-fg-muted">· {help}</span>
            </p>
            <ul aria-label={`${SCOPE_INFO[scoped.scope].label} ${title.toLowerCase()} rules`} className="flex flex-col gap-4">
              {draft[kind].length === 0 ? <li className="text-sm text-fg-faint">None</li> : null}
              {draft[kind].map((rule) => (
                <li key={rule} className="flex items-center gap-4 rounded-sm bg-surface py-2 pr-2 pl-8">
                  <span className="selectable min-w-0 flex-1 truncate font-mono text-sm text-fg" title={rule}>
                    {rule}
                  </span>
                  <IconButton label={`Remove ${rule}`} size="xs" disabled={readOnly} onClick={() => setDraft({ ...draft, [kind]: draft[kind].filter((r) => r !== rule) })}>
                    <X className="size-12" />
                  </IconButton>
                </li>
              ))}
            </ul>
            <form
              className="flex items-center gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                add(kind);
              }}
            >
              <input
                aria-label={`New ${title.toLowerCase()} rule`}
                value={inputs[kind]}
                disabled={readOnly}
                placeholder={kind === 'allow' ? 'Shell(npm test:*)' : kind === 'ask' ? 'Shell(git push:*)' : 'Read(.env)'}
                spellCheck={false}
                onChange={(e) => setInputs({ ...inputs, [kind]: e.target.value })}
                className="h-26 min-w-0 flex-1 rounded-sm border border-input-border bg-input px-8 font-mono text-sm text-fg outline-none placeholder:text-fg-placeholder focus:border-border-strong"
              />
              <IconButton type="submit" label={`Add ${title.toLowerCase()} rule`} size="sm" disabled={readOnly || inputs[kind].trim().length === 0}>
                <Plus className="size-14" />
              </IconButton>
            </form>
          </div>
        ))}
      </div>
      {dirty || error ? (
        <div className="flex items-center gap-8 px-14 py-8">
          <p role={error ? 'alert' : undefined} className={cn('min-w-0 flex-1 text-sm', error ? 'text-danger' : 'text-fg-muted')}>
            {error ?? 'Unsaved changes.'}
          </p>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft({ allow: scoped.allow, ask: scoped.ask, deny: scoped.deny })}>
            Discard
          </Button>
          <Button size="sm" variant="primary" disabled={busy || !dirty} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save rules'}
          </Button>
        </div>
      ) : null}
    </Group>
  );
}

export function PermissionsSection() {
  const settings = useApp((s) => s.settings);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [confirmBypass, setConfirmBypass] = useState(false);
  const { load: rules } = useLoad(() => invoke('permissions:get', { projectPath }), `${projectPath ?? ''}:${version}`);
  const project = useApp((s) => s.projects.find((p) => p.path === projectPath) ?? null);
  const windows = useApp((s) => s.environment?.platform === 'win32');
  if (!settings) return null;
  const bypass = settings.behavior.bypassModeEnabled;
  const modes = (Object.keys(PERMISSION_MODE_INFO) as PermissionMode[]).filter((m) => m !== 'bypass' || bypass);

  return (
    <div className="flex flex-col gap-24">
      <Group title="Modes">
        <SettingRow label="Default mode for new code sessions" description={PERMISSION_MODE_INFO[settings.defaults.permissionMode].description}>
          <div role="radiogroup" aria-label="Default permission mode" className="flex flex-wrap gap-6">
            {modes.map((mode) => {
              const selected = settings.defaults.permissionMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => saveSettings({ defaults: { permissionMode: mode } })}
                  className={cn(
                    'inline-flex h-28 items-center rounded-md border px-10 text-base transition-ui',
                    selected ? 'border-toggle-thumb-border bg-toggle-thumb text-fg-strong' : 'border-border text-fg-secondary hover:bg-hover'
                  )}
                >
                  {PERMISSION_MODE_INFO[mode].label}
                </button>
              );
            })}
          </div>
        </SettingRow>
        <SettingRow
          label="Allow Bypass mode"
          description="Adds Bypass to the mode menu and the Shift+Tab cycle. In Bypass the agent runs commands, edits and tools without asking; only your deny rules still block."
          control={
            <Switch
              label="Allow Bypass mode"
              checked={bypass}
              onChange={(on) => {
                if (on) setConfirmBypass(true);
                else saveSettings({ behavior: { bypassModeEnabled: false } });
              }}
            />
          }
        />
        {bypass ? (
          <SettingRow
            label="Keep safety checks in Bypass"
            description="Still ask before dangerous commands (recursive deletes, force pushes, piping downloads to a shell), writes outside the project, and changes to Graft or git configuration."
            control={
              <Switch
                label="Keep safety checks in Bypass"
                checked={settings.behavior.bypassKeepsChecks}
                onChange={(on) => saveSettings({ behavior: { bypassKeepsChecks: on } })}
              />
            }
          />
        ) : null}
        <SettingRow
          label="Steps per turn"
          description="How many steps the agent may take before it pauses and offers to continue. With no limit it works until the task is done; it still stops if it repeats the same actions."
          control={
            <LimitSelect label="Steps per turn" value={settings.behavior.maxSteps} choices={STEP_LIMITS} format={(n) => `${n.toLocaleString()} steps`} onChange={(maxSteps) => saveSettings({ behavior: { maxSteps } })} />
          }
        />
        <SettingRow
          label="Tokens per turn"
          description="Pause a turn once it has used about this many tokens, with the agents it started. Tokens read from a provider's cache count at a tenth, as they are billed."
          control={
            <LimitSelect label="Tokens per turn" value={settings.behavior.turnTokens} choices={TOKEN_LIMITS} format={(n) => `${n.toLocaleString()} tokens`} onChange={(turnTokens) => saveSettings({ behavior: { turnTokens } })} />
          }
        />
        <SettingRow
          label="Cost per turn"
          description="Pause a turn at about this much. The amount is worked out from published prices, so your bill can differ, and a model with no published price can't be followed: Graft says so when one answers."
          control={
            <LimitSelect label="Cost per turn" value={settings.behavior.turnCostUsd} choices={COST_LIMITS} format={dollars} onChange={(turnCostUsd) => saveSettings({ behavior: { turnCostUsd } })} />
          }
        />
        <SettingRow
          label="Time per turn"
          description="Pause a turn after it has worked this long. The time it waits for your answer doesn't count."
          control={
            <LimitSelect label="Time per turn" value={settings.behavior.turnMinutes} choices={MINUTE_LIMITS} format={duration} onChange={(turnMinutes) => saveSettings({ behavior: { turnMinutes } })} />
          }
        />
      </Group>

      <Group title="Computer use">
        <SettingRow
          label="Let the agent use this computer"
          description={
            windows
              ? 'Code sessions with a model that can see images may take screenshots and use the mouse and keyboard. Each action asks first unless you allow it for the session, and a banner shows while it is in control. Press Ctrl+Alt+Esc to stop it.'
              : 'Available on Windows for now.'
          }
          control={
            <Switch
              label="Let the agent use this computer"
              checked={windows && settings.behavior.computerUse}
              disabled={!windows}
              onChange={(on) => saveSettings({ behavior: { computerUse: on } })}
            />
          }
        />
      </Group>

      <section aria-label="Rules" className="flex flex-col gap-12">
        <header className="flex flex-wrap items-end gap-12">
          <div className="min-w-[260px] flex-1">
            <h3 className="text-md font-medium text-fg-strong">Rules</h3>
            <p className="mt-2 text-sm text-fg-muted">
              Patterns per tool: <span className="font-mono">Shell(npm test:*)</span>, <span className="font-mono">Edit(src/**)</span>,{' '}
              <span className="font-mono">Read(~/.ssh/**)</span>, <span className="font-mono">WebFetch(domain:example.com)</span>. Deny wins over ask, ask over allow.
            </p>
          </div>
          <ProjectPicker value={projectPath} onChange={setProjectPath} />
        </header>
        {project && !project.trusted ? (
          <p className="rounded-md border border-border bg-warning-bg px-12 py-8 text-sm text-warning-fg">
            {project.name} isn’t trusted, so its allow rules are ignored until you trust it in Projects. Its ask and deny rules always apply.
          </p>
        ) : null}
        {rules.status === 'loading' ? <LoadingState label="Loading rules…" className="py-16" /> : null}
        {rules.status === 'error' ? <ErrorState title="Couldn't load rules" message={rules.message} onRetry={() => setVersion((v) => v + 1)} /> : null}
        {rules.status === 'ready'
          ? rules.data.map((scoped) => (
              <RulesEditor
                key={JSON.stringify([scoped.path, scoped.error, scoped.allow, scoped.ask, scoped.deny])}
                scoped={scoped}
                projectPath={projectPath}
                onSaved={() => setVersion((v) => v + 1)}
              />
            ))
          : null}
      </section>

      <ConfirmDialog
        open={confirmBypass}
        onOpenChange={setConfirmBypass}
        title="Allow Bypass mode?"
        description="In Bypass, the agent edits files, runs commands and uses tools without asking, including deletes and writes outside the project. Use it in sandboxes or throwaway copies, never on work you can't lose. Deny rules still apply."
        confirmLabel="Allow Bypass"
        danger
        onConfirm={async () => {
          await useApp.getState().updateSettings({ behavior: { bypassModeEnabled: true } });
        }}
      />
    </div>
  );
}
