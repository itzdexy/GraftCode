import { useState } from 'react';
import { Plus, Trash } from 'lucide-react';
import { HOOK_EVENTS, type HookEvent, type HooksConfig, type SettingsScope } from '@shared/schemas/config';
import type { ScopedHooksView } from '@shared/schemas/customize';
import { Badge } from '../../components/Badge';
import { Button, IconButton } from '../../components/Button';
import { Dialog, DialogContent } from '../../components/Dialog';
import { TextField } from '../../components/Field';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { errorText, invoke } from '../../lib/ipc';
import { useLoad } from '../../lib/useLoad';
import { reportError } from '../../stores/toasts';
import { Row, Section, SELECT } from './shared';

const EVENT_HELP: Record<HookEvent, string> = {
  PreToolUse: 'Before a tool runs. Exit code 2 blocks the call; stdout JSON can allow or deny it.',
  PostToolUse: 'After a tool finishes, e.g. to run a formatter on edited files.',
  UserPromptSubmit: 'When you send a message. Exit code 2 blocks it; stdout is added as context.',
  Stop: 'When the agent is about to finish its turn. Exit code 2 sends it back to work with your message.'
};

const SCOPE_TEXT: Record<SettingsScope, string> = { user: 'All projects', project: 'Project (shared)', local: 'Project (this computer)' };

interface Flat {
  scope: SettingsScope;
  event: HookEvent;
  matcherIndex: number;
  hookIndex: number;
  matcher: string | undefined;
  command: string;
  timeout: number | undefined;
}

function flatten(scoped: ScopedHooksView[]): Flat[] {
  const out: Flat[] = [];
  for (const s of scoped) {
    for (const event of HOOK_EVENTS) {
      (s.hooks[event] ?? []).forEach((m, matcherIndex) =>
        m.hooks.forEach((h, hookIndex) => out.push({ scope: s.scope, event, matcherIndex, hookIndex, matcher: m.matcher, command: h.command, timeout: h.timeout }))
      );
    }
  }
  return out;
}

function withoutHook(hooks: HooksConfig, target: Flat): HooksConfig {
  const next: HooksConfig = structuredClone(hooks);
  const list = next[target.event] ?? [];
  const matcher = list[target.matcherIndex];
  if (!matcher) return next;
  matcher.hooks.splice(target.hookIndex, 1);
  if (matcher.hooks.length === 0) list.splice(target.matcherIndex, 1);
  if (list.length === 0) delete next[target.event];
  else next[target.event] = list;
  return next;
}

function AddHook({ scoped, projectPath, onDone }: { scoped: ScopedHooksView[]; projectPath: string | null; onDone: (saved: boolean) => void }) {
  const [scope, setScope] = useState<SettingsScope>('user');
  const [event, setEvent] = useState<HookEvent>('PostToolUse');
  const [matcher, setMatcher] = useState('Edit|Write|MultiEdit');
  const [command, setCommand] = useState('');
  const [timeout, setTimeoutValue] = useState('60');
  const [error, setError] = useState<string | null>(null);
  const toolEvent = event === 'PreToolUse' || event === 'PostToolUse';

  const save = async (): Promise<void> => {
    const current = scoped.find((s) => s.scope === scope);
    if (current?.error) {
      setError(current.error);
      return;
    }
    const hooks: HooksConfig = structuredClone(current?.hooks ?? {});
    const seconds = Number(timeout);
    const entry = { type: 'command' as const, command: command.trim(), ...(Number.isInteger(seconds) && seconds > 0 ? { timeout: Math.min(600, seconds) } : {}) };
    (hooks[event] ??= []).push({ ...(toolEvent && matcher.trim() ? { matcher: matcher.trim() } : {}), hooks: [entry] });
    try {
      await invoke('customize:saveHooks', { scope, projectPath: scope === 'user' ? null : projectPath, hooks });
      onDone(true);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <DialogContent
      title="Add hook"
      description="Hooks run shell commands at points in the agent loop. They receive the event as JSON on stdin."
      className="w-[min(580px,calc(100vw-48px))]"
      footer={
        <>
          <Button variant="ghost" onClick={() => onDone(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!command.trim()} onClick={() => void save()}>
            Add hook
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-12">
        <div className="grid grid-cols-2 gap-8">
          <label className="flex flex-col gap-6 text-base font-medium text-fg-secondary">
            Event
            <select className={SELECT} value={event} onChange={(e) => setEvent(e.target.value as HookEvent)}>
              {HOOK_EVENTS.map((ev) => (
                <option key={ev} value={ev}>
                  {ev}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-6 text-base font-medium text-fg-secondary">
            Saved in
            <select className={SELECT} value={scope} onChange={(e) => setScope(e.target.value as SettingsScope)}>
              <option value="user">{SCOPE_TEXT.user}</option>
              <option value="project" disabled={!projectPath}>
                {SCOPE_TEXT.project}
              </option>
              <option value="local" disabled={!projectPath}>
                {SCOPE_TEXT.local}
              </option>
            </select>
          </label>
        </div>
        <p className="text-sm text-fg-muted">{EVENT_HELP[event]}</p>
        {toolEvent ? <TextField label="Tools (pattern)" value={matcher} onChange={(e) => setMatcher(e.target.value)} hint='e.g. "Shell", "Edit|Write", or "*" for all' inputClassName="font-mono" /> : null}
        <TextField label="Command" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx prettier --write ." inputClassName="font-mono" spellCheck={false} />
        <TextField label="Timeout (seconds)" value={timeout} onChange={(e) => setTimeoutValue(e.target.value)} inputMode="numeric" className="max-w-[160px]" />
        {error ? (
          <p role="alert" className="text-base text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </DialogContent>
  );
}

export function HooksSection({ projectPath }: { projectPath: string | null }) {
  const { load, reload } = useLoad(() => invoke('customize:hooks', { projectPath }), projectPath ?? '');
  const [adding, setAdding] = useState(false);
  const scoped = load.status === 'ready' ? load.data : [];
  const flat = flatten(scoped);

  const remove = (target: Flat): void => {
    const current = scoped.find((s) => s.scope === target.scope);
    if (!current) return;
    invoke('customize:saveHooks', { scope: target.scope, projectPath: target.scope === 'user' ? null : projectPath, hooks: withoutHook(current.hooks, target) })
      .then(reload)
      .catch((e: unknown) => reportError("Couldn't remove the hook", e));
  };

  return (
    <Section
      title="Hooks"
      description="Commands that run on agent events, from settings.json files. Project hooks run only in trusted projects."
      actions={
        <Button size="sm" variant="secondary" leading={<Plus className="size-14" />} onClick={() => setAdding(true)}>
          Add hook
        </Button>
      }
    >
      {load.status === 'loading' ? <LoadingState /> : null}
      {load.status === 'error' ? <ErrorState message={load.message} onRetry={reload} /> : null}
      {scoped
        .filter((s) => s.error)
        .map((s) => (
          <p key={s.scope} role="alert" className="selectable text-sm text-danger">
            {s.error}
          </p>
        ))}
      {load.status === 'ready' && flat.length === 0 ? <EmptyState title="No hooks" description="Run formatters after edits, block risky commands, or add context to prompts." /> : null}
      {flat.length > 0 ? (
        <ul className="flex flex-col gap-[var(--g-session-row-gap)]">
          {flat.map((h) => (
            <Row key={`${h.scope}:${h.event}:${h.matcherIndex}:${h.hookIndex}`}>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-6">
                  <Badge>{h.event}</Badge>
                  {h.matcher ? <span className="font-mono text-sm text-fg-muted">{h.matcher}</span> : null}
                  <Badge>{SCOPE_TEXT[h.scope]}</Badge>
                </p>
                <p className="selectable truncate font-mono text-sm text-fg-secondary">{h.command}</p>
              </div>
              <IconButton label="Remove hook" onClick={() => remove(h)}>
                <Trash className="size-14" />
              </IconButton>
            </Row>
          ))}
        </ul>
      ) : null}
      <Dialog open={adding} onOpenChange={setAdding}>
        {adding ? (
          <AddHook
            scoped={scoped}
            projectPath={projectPath}
            onDone={(saved) => {
              setAdding(false);
              if (saved) reload();
            }}
          />
        ) : null}
      </Dialog>
    </Section>
  );
}
