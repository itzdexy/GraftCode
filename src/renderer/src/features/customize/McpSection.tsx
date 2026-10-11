import { useEffect, useState } from 'react';
import { ChevronRight, KeyRound, Pencil, Plus, RefreshCw, Trash } from 'lucide-react';
import type { McpInherit, SettingsScope } from '@shared/schemas/config';
import type { McpServerInput, McpServerView } from '@shared/schemas/customize';
import type { RuleLists } from '@shared/schemas/system';
import { effectivePolicy, mcpServerRule, policyOf, withPolicy, type ToolPolicy } from '@shared/mcpPolicy';
import { Badge } from '../../components/Badge';
import { Button, IconButton } from '../../components/Button';
import { Spinner } from '../../components/ContextRing';
import { Dialog, DialogContent } from '../../components/Dialog';
import { Checkbox, TextField } from '../../components/Field';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { onChanged } from '../../lib/bus';
import { cn } from '../../lib/cn';
import { errorText, invoke } from '../../lib/ipc';
import { useLoad, type Load } from '../../lib/useLoad';
import { reportError } from '../../stores/toasts';
import { IntegrationsGallery } from './IntegrationsGallery';
import { serverSummary } from './mcpModel';
import { MONO_AREA, parsePairs, Row, Section, SELECT } from './shared';

const SCOPE_TEXT: Record<SettingsScope, string> = { user: 'All projects', project: 'Project (shared)', local: 'Project (this computer)' };

/** Said under the choice. None of the three is a sandbox, and each says so. */
const INHERIT_HELP: Record<McpInherit, string> = {
  'no-secrets': 'Variables named like a key, token or password are left out, and so are addresses with a password in them. Give the server the ones it needs above. It still runs as you and can read your files.',
  minimal: 'Only your home folder, PATH and the like. Runtimes that read their own settings from the environment may need more. It still runs as you and can read your files.',
  all: 'Every variable, keys and tokens included, as a program started from a terminal would get.'
};

const POLICY_TEXT: Record<ToolPolicy, string> = { default: 'Default', ask: 'Always ask', allow: 'Allow', deny: 'Never' };
/** A choice at the end of a row; the shared SELECT is a full-width form field. */
const POLICY_SELECT = 'h-24 shrink-0 rounded-md border border-input-border bg-input px-6 text-sm text-fg outline-none focus:border-border-strong';

/** The user's rules for all projects, and how to change one of them. Null while they load or when the file can't be used. */
interface Policies {
  rules: RuleLists;
  set(rule: string, policy: ToolPolicy): void;
}

/** One permission choice. "Default" leaves it to the permission mode: ask, unless the mode allows the call. */
function PolicySelect({ label, value, onChange }: { label: string; value: ToolPolicy; onChange: (policy: ToolPolicy) => void }) {
  return (
    <select aria-label={label} className={POLICY_SELECT} value={value} onChange={(e) => onChange(e.target.value as ToolPolicy)}>
      {(['default', 'ask', 'allow', 'deny'] as const).map((policy) => (
        <option key={policy} value={policy}>
          {POLICY_TEXT[policy]}
        </option>
      ))}
    </select>
  );
}

function StateDot({ state }: { state: McpServerView['state'] }) {
  if (state === 'connecting') return <Spinner size={10} label="Connecting" />;
  const color = state === 'connected' ? 'bg-success' : state === 'failed' ? 'bg-danger' : state === 'needs-auth' ? 'bg-amber' : 'bg-fg-faint';
  return <span className={cn('size-6 shrink-0 rounded-full', color)} aria-hidden="true" />;
}

function ServerEditor({ server, projectPath, onDone }: { server: McpServerView | null; projectPath: string | null; onDone: (saved: boolean) => void }) {
  const config = server?.config;
  const [name, setName] = useState(server?.name ?? '');
  const [scope, setScope] = useState<SettingsScope>(server?.scope ?? 'user');
  const [type, setType] = useState<'stdio' | 'http'>(config?.type ?? 'stdio');
  const [command, setCommand] = useState(config?.type === 'stdio' ? config.command : '');
  const [args, setArgs] = useState(config?.type === 'stdio' ? config.args.join('\n') : '');
  const [cwd, setCwd] = useState(config?.type === 'stdio' ? (config.cwd ?? '') : '');
  // A new server does not get this computer's keys and tokens unless that is chosen; an existing one keeps what it had.
  const [inherit, setInherit] = useState<McpInherit>(config?.type === 'stdio' ? config.inherit : 'no-secrets');
  const [url, setUrl] = useState(config?.type === 'http' ? config.url : '');
  const [secrets, setSecrets] = useState('');
  const existingKeys = config?.type === 'stdio' ? config.envKeys : config?.type === 'http' ? config.headerKeys : [];
  const [keep, setKeep] = useState<string[]>(existingKeys);
  const [enabled, setEnabled] = useState(config?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    const parsed = parsePairs(secrets, type === 'stdio' ? '=' : ':');
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    const input: McpServerInput =
      type === 'stdio'
        ? { type: 'stdio', command: command.trim(), args: args.split(/\r?\n/).map((a) => a.trim()).filter(Boolean), env: parsed.pairs, keepEnv: keep, cwd: cwd.trim() || null, inherit, enabled }
        : { type: 'http', url: url.trim(), headers: parsed.pairs, keepHeaders: keep, enabled };
    setBusy(true);
    setError(null);
    try {
      await invoke('mcp:save', { scope, projectPath: scope === 'user' ? null : projectPath, name: name.trim(), previousName: server?.name ?? null, config: input });
      onDone(true);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <DialogContent
      title={server ? `Edit ${server.name}` : 'Add MCP server'}
      description="Graft starts the server and offers its tools to the agent as mcp__server__tool. Tools that change things ask for permission."
      className="w-[min(600px,calc(100vw-48px))]"
      footer={
        <>
          <Button variant="ghost" onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !name.trim() || (type === 'stdio' ? !command.trim() : !url.trim())} onClick={() => void save()}>
            {busy ? <Spinner size={12} label="Connecting" /> : null}
            {server ? 'Save' : 'Add server'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-12">
        <div className="grid grid-cols-[1fr_200px] gap-8">
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="github" spellCheck={false} disabled={server !== null} />
          <label className="flex flex-col gap-6 text-base font-medium text-fg-secondary">
            Saved in
            <select className={SELECT} value={scope} onChange={(e) => setScope(e.target.value as SettingsScope)} disabled={server !== null}>
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
        <div role="radiogroup" aria-label="Connection" className="flex gap-6">
          {(['stdio', 'http'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={type === t}
              onClick={() => setType(t)}
              className={cn('h-26 rounded-md border px-10 text-base', type === t ? 'border-toggle-thumb-border bg-toggle-thumb text-fg-strong' : 'border-border text-fg-secondary hover:bg-hover')}
            >
              {t === 'stdio' ? 'Local command' : 'Remote URL'}
            </button>
          ))}
        </div>
        {type === 'stdio' ? (
          <>
            <TextField label="Command" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" spellCheck={false} inputClassName="font-mono" />
            <label className="flex flex-col gap-6 text-base font-medium text-fg-secondary">
              Arguments (one per line)
              <textarea aria-label="Arguments" className={MONO_AREA} rows={3} value={args} onChange={(e) => setArgs(e.target.value)} placeholder={'-y\n@example/mcp-server'} />
            </label>
            <TextField label="Working folder (optional)" value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} inputClassName="font-mono" />
          </>
        ) : (
          <TextField label="URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" spellCheck={false} inputClassName="font-mono" />
        )}
        <label className="flex flex-col gap-6 text-base font-medium text-fg-secondary">
          {type === 'stdio' ? 'Environment variables (NAME=value per line)' : 'Headers (Name: value per line)'}
          <textarea aria-label={type === 'stdio' ? 'Environment variables' : 'Headers'} className={MONO_AREA} rows={3} value={secrets} onChange={(e) => setSecrets(e.target.value)} spellCheck={false} />
        </label>
        {type === 'stdio' ? (
          <label className="flex flex-col gap-6 text-base font-medium text-fg-secondary">
            What it gets from this computer's environment
            <select aria-label="What it gets from this computer's environment" className={SELECT} value={inherit} onChange={(e) => setInherit(e.target.value as McpInherit)}>
              <option value="no-secrets">Everything except keys, tokens and passwords</option>
              <option value="minimal">Only what a program needs to start</option>
              <option value="all">Everything</option>
            </select>
            <span className="text-sm font-normal text-fg-muted">{INHERIT_HELP[inherit]}</span>
          </label>
        ) : null}
        {existingKeys.length > 0 ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-fg-muted">Saved values (not shown). Untick to remove; a new line with the same name replaces it.</p>
            {existingKeys.map((k) => (
              <Checkbox key={k} label={<span className="font-mono">{k}</span>} checked={keep.includes(k)} onChange={(e) => setKeep(e.target.checked ? [...keep, k] : keep.filter((x) => x !== k))} />
            ))}
          </div>
        ) : null}
        <Checkbox label="Enabled" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {error ? (
          <p role="alert" className="selectable text-base text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </DialogContent>
  );
}

function ServerRow({ server, projectPath, policies, onEdit, onChange }: { server: McpServerView; projectPath: string | null; policies: Policies | null; onEdit: () => void; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const scopeProject = server.scope === 'user' ? null : projectPath;
  const act = (label: string, run: () => Promise<unknown>): void => {
    setBusy(true);
    run()
      .then(onChange)
      .catch((e: unknown) => reportError(label, e))
      .finally(() => setBusy(false));
  };
  const summary = serverSummary(server);
  const expandable = server.tools.length > 0 || server.prompts.length > 0;
  return (
    <Row className="flex-wrap">
      <StateDot state={server.state} />
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-8 text-left" disabled={!expandable}>
        <span className="text-base font-medium text-fg-strong">{server.name}</span>
        <Badge>{SCOPE_TEXT[server.scope]}</Badge>
        <span className="min-w-0 truncate text-sm text-fg-muted">{summary}</span>
        {expandable ? <ChevronRight className={cn('size-12 shrink-0 text-icon-muted transition-transform', open && 'rotate-90')} aria-hidden="true" /> : null}
      </button>
      {server.state === 'needs-auth' ? (
        <Button size="sm" variant="secondary" leading={<KeyRound className="size-12" />} disabled={busy} onClick={() => act("Couldn't sign in", () => invoke('mcp:authorize', { name: server.name }))}>
          Sign in
        </Button>
      ) : null}
      <Checkbox
        label="On"
        checked={server.config.enabled}
        onChange={(e) => act("Couldn't update the server", () => invoke('mcp:setEnabled', { scope: server.scope, projectPath: scopeProject, name: server.name, enabled: e.target.checked }))}
      />
      <IconButton label={`Reconnect ${server.name}`} disabled={busy || !server.config.enabled} onClick={() => act("Couldn't reconnect", () => invoke('mcp:reconnect', { name: server.name }))}>
        <RefreshCw className="size-14" />
      </IconButton>
      <IconButton label={`Edit ${server.name}`} onClick={onEdit}>
        <Pencil className="size-14" />
      </IconButton>
      <IconButton label={`Remove ${server.name}`} onClick={() => act("Couldn't remove the server", () => invoke('mcp:remove', { scope: server.scope, projectPath: scopeProject, name: server.name }))}>
        <Trash className="size-14" />
      </IconButton>
      {server.error ? (
        <p role="alert" className="selectable basis-full pl-14 text-sm break-words text-danger">
          {server.error}
        </p>
      ) : null}
      {server.hint ? <p className="selectable basis-full pl-14 text-sm break-words text-fg-muted">{server.hint}</p> : null}
      {open ? (
        <ul className="basis-full pl-14">
          {policies && server.tools.length > 0 ? (
            <li className="flex flex-wrap items-center gap-x-8 py-2 text-sm">
              <span className="min-w-0 flex-1 text-fg-secondary">Every tool of {server.name}</span>
              <PolicySelect label={`Permission for every tool of ${server.name}`} value={policyOf(policies.rules, mcpServerRule(server.name))} onChange={(policy) => policies.set(mcpServerRule(server.name), policy)} />
              <span className="basis-full text-fg-muted">The stricter of this and a tool's own choice applies. A read-only label is the server's own word.</span>
            </li>
          ) : null}
          {server.tools.map((t) => {
            const own = policies ? policyOf(policies.rules, t.registeredAs) : 'default';
            const effective = policies ? effectivePolicy(policies.rules, t.registeredAs) : 'default';
            return (
              <li key={t.name} className="flex items-center gap-8 py-2 text-sm">
                <span className="shrink-0 font-mono text-fg-secondary">{t.name}</span>
                {t.readOnly ? <Badge>read-only</Badge> : null}
                <span className="min-w-0 flex-1 truncate text-fg-muted">{t.description}</span>
                {effective !== own ? <span className="shrink-0 text-fg-muted">{POLICY_TEXT[effective]}, from the server's rule</span> : null}
                {policies ? <PolicySelect label={`Permission for ${t.name}`} value={own} onChange={(policy) => policies.set(t.registeredAs, policy)} /> : null}
              </li>
            );
          })}
          {server.prompts.map((p) => (
            <li key={p.command} className="flex gap-8 py-2 text-sm">
              <span className="shrink-0 font-mono text-fg-secondary">
                /{p.command}
                {p.argumentHint ? ` ${p.argumentHint}` : ''}
              </span>
              <Badge>prompt</Badge>
              <span className="min-w-0 truncate text-fg-muted">{p.description}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Row>
  );
}

export function McpSection({ projectPath }: { projectPath: string | null }) {
  const { load, reload } = useLoad(() => invoke('mcp:list', { projectPath }), projectPath ?? '');
  const [editing, setEditing] = useState<McpServerView | 'new' | null>(null);
  useEffect(() => onChanged('mcp', reload), [reload]);
  const installed = new Set(load.status === 'ready' ? load.data.filter((s) => s.scope === 'user').map((s) => s.name) : []);
  return (
    <div className="flex flex-col gap-28">
      <IntegrationsGallery installed={installed} onAdded={reload} />
      <McpServers projectPath={projectPath} load={load} reload={reload} editing={editing} setEditing={setEditing} />
    </div>
  );
}

function McpServers({
  projectPath,
  load,
  reload,
  editing,
  setEditing
}: {
  projectPath: string | null;
  load: Load<McpServerView[]>;
  reload: () => void;
  editing: McpServerView | 'new' | null;
  setEditing: (editing: McpServerView | 'new' | null) => void;
}) {
  // A tool's permission is an ordinary rule in the user's settings: the list Settings → Permissions shows.
  const { load: rulesLoad, reload: reloadRules } = useLoad(() => invoke('permissions:get', { projectPath: null }), 'mcp-policies');
  const user = rulesLoad.status === 'ready' ? rulesLoad.data.find((scoped) => scoped.scope === 'user') : undefined;
  const policies: Policies | null =
    user && user.error === null
      ? {
          rules: { allow: user.allow, ask: user.ask, deny: user.deny },
          set: (rule, policy) => {
            invoke('permissions:save', { scope: 'user', projectPath: null, rules: withPolicy({ allow: user.allow, ask: user.ask, deny: user.deny }, rule, policy) })
              .then(reloadRules)
              .catch((e: unknown) => reportError("Couldn't save the permission", e));
          }
        }
      : null;
  return (
    <Section
      title="MCP servers"
      description="Connect tools and data from other apps. Project servers only run once you trust the project."
      actions={
        <Button size="sm" variant="secondary" leading={<Plus className="size-14" />} onClick={() => setEditing('new')}>
          Add server
        </Button>
      }
    >
      {load.status === 'loading' ? <LoadingState /> : null}
      {load.status === 'error' ? <ErrorState message={load.message} onRetry={reload} /> : null}
      {load.status === 'ready' && load.data.length === 0 ? <EmptyState title="No MCP servers" description="Add a local command or a remote URL." /> : null}
      {load.status === 'ready' && load.data.length > 0 ? (
        <ul aria-label="MCP servers" className="flex flex-col gap-[var(--g-session-row-gap)]">
          {load.data.map((s) => (
            <ServerRow key={`${s.scope}:${s.name}`} server={s} projectPath={projectPath} policies={policies} onEdit={() => setEditing(s)} onChange={reload} />
          ))}
        </ul>
      ) : null}
      <Dialog open={editing !== null} onOpenChange={(open) => (open ? undefined : setEditing(null))}>
        {editing ? (
          <ServerEditor
            key={editing === 'new' ? 'new' : `${editing.scope}:${editing.name}`}
            server={editing === 'new' ? null : editing}
            projectPath={projectPath}
            onDone={(saved) => {
              setEditing(null);
              if (saved) reload();
            }}
          />
        ) : null}
      </Dialog>
    </Section>
  );
}
