import { useEffect, useState } from 'react';
import { ChevronRight, KeyRound, Pencil, Plus, RefreshCw, Trash } from 'lucide-react';
import type { SettingsScope } from '@shared/schemas/config';
import type { McpServerInput, McpServerView } from '@shared/schemas/customize';
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
import { MONO_AREA, parsePairs, Row, Section, SELECT } from './shared';

const STATE_TEXT: Record<McpServerView['state'], string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  failed: 'Failed',
  disabled: 'Off',
  'needs-auth': 'Sign-in needed',
  idle: 'Starts with a session in this project',
  untrusted: 'Off until you trust this project'
};

const SCOPE_TEXT: Record<SettingsScope, string> = { user: 'All projects', project: 'Project (shared)', local: 'Project (this computer)' };

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
        ? { type: 'stdio', command: command.trim(), args: args.split(/\r?\n/).map((a) => a.trim()).filter(Boolean), env: parsed.pairs, keepEnv: keep, cwd: cwd.trim() || null, enabled }
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

function ServerRow({ server, projectPath, onEdit, onChange }: { server: McpServerView; projectPath: string | null; onEdit: () => void; onChange: () => void }) {
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
  const summary =
    server.state === 'connected'
      ? server.tools.length === 0
        ? `${STATE_TEXT.connected} · waiting for tools`
        : `${STATE_TEXT.connected} · ${server.tools.length} ${server.tools.length === 1 ? 'tool' : 'tools'}`
      : STATE_TEXT[server.state];
  return (
    <Row className="flex-wrap">
      <StateDot state={server.state} />
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-8 text-left" disabled={server.tools.length === 0}>
        <span className="text-base font-medium text-fg-strong">{server.name}</span>
        <Badge>{SCOPE_TEXT[server.scope]}</Badge>
        <span className="min-w-0 truncate text-sm text-fg-muted">{summary}</span>
        {server.tools.length > 0 ? <ChevronRight className={cn('size-12 shrink-0 text-icon-muted transition-transform', open && 'rotate-90')} aria-hidden="true" /> : null}
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
          {server.tools.map((t) => (
            <li key={t.name} className="flex gap-8 py-2 text-sm">
              <span className="shrink-0 font-mono text-fg-secondary">{t.name}</span>
              {t.readOnly ? <Badge>read-only</Badge> : null}
              <span className="min-w-0 truncate text-fg-muted">{t.description}</span>
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
            <ServerRow key={`${s.scope}:${s.name}`} server={s} projectPath={projectPath} onEdit={() => setEditing(s)} onChange={reload} />
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
