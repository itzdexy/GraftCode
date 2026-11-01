import { useId, useState } from 'react';
import type { McpImportView } from '@shared/schemas/customize';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Spinner } from '../../components/ContextRing';
import { DialogContent } from '../../components/Dialog';
import { Checkbox } from '../../components/Field';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { errorText, invoke } from '../../lib/ipc';
import { useLoad } from '../../lib/useLoad';
import { useToasts } from '../../stores/toasts';
import { launchLine, SCOPE_TEXT } from './mcpModel';

/** The places looked in, as the empty list says them. */
const LOOKED_IN = '.mcp.json and .cursor/mcp.json in the project, ~/.claude.json, ~/.cursor/mcp.json, ~/.codex/config.toml and claude_desktop_config.json';

function FoundRow({ server, checked, onChange }: { server: McpImportView; checked: boolean; onChange: (checked: boolean) => void }) {
  const detailsId = useId();
  return (
    <li className="flex flex-col gap-2 rounded-md bg-raised px-12 py-8">
      <div className="flex flex-wrap items-center gap-8">
        <Checkbox
          label={<span className="font-medium text-fg-strong">{server.name}</span>}
          checked={checked}
          disabled={server.exists}
          aria-describedby={detailsId}
          onChange={(e) => onChange(e.target.checked)}
        />
        <Badge>{SCOPE_TEXT[server.scope]}</Badge>
        {server.exists ? <Badge>Already in Graft</Badge> : null}
      </div>
      <div id={detailsId} className="flex min-w-0 flex-col gap-2 pl-15 text-sm text-fg-muted">
        <p className="selectable truncate font-mono" title={launchLine(server.config)}>
          {launchLine(server.config)}
        </p>
        <p>
          Found in <span className="selectable font-mono">{server.from}</span>
        </p>
        {server.missing.length > 0 ? <p className="text-warning-fg">Needs {server.missing.join(', ')}, which this computer doesn’t set.</p> : null}
      </div>
    </li>
  );
}

/**
 * Customize → Integrations → Import: the MCP servers other coding tools have
 * set up, read from their settings files. Ticked ones are added as Graft's own
 * when the user says so; nothing starts before that.
 */
export function McpImportDialog({ projectPath, onDone }: { projectPath: string | null; onDone: (added: boolean) => void }) {
  const { load, reload } = useLoad(() => invoke('mcp:findImports', { projectPath }), `imports:${projectPath ?? ''}`);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { added } = await invoke('mcp:import', { projectPath, ids: picked });
      useToasts.getState().push({ tone: 'success', title: added.length === 1 ? `${added[0] ?? ''} added` : `${String(added.length)} servers added` });
      onDone(true);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const count = picked.length;
  return (
    <DialogContent
      title="Import MCP servers"
      description="Servers other coding tools on this computer have set up. Nothing starts until you add them, and their tools ask for permission as any server’s do. Values that look like keys or tokens go to Graft’s key store."
      className="w-[min(620px,calc(100vw-48px))]"
      footer={
        <>
          <Button variant="ghost" onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || count === 0} onClick={() => void add()}>
            {busy ? <Spinner size={12} label="Adding" /> : null}
            {count === 0 ? 'Add servers' : count === 1 ? 'Add 1 server' : `Add ${String(count)} servers`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-12">
        {load.status === 'loading' ? <LoadingState label="Looking for servers…" /> : null}
        {load.status === 'error' ? <ErrorState message={load.message} onRetry={reload} /> : null}
        {load.status === 'ready' && load.data.servers.length === 0 ? <EmptyState title="No servers found" description={`Graft looked in ${LOOKED_IN}.`} /> : null}
        {load.status === 'ready' && load.data.servers.length > 0 ? (
          <ul aria-label="Servers found" className="flex flex-col gap-[var(--g-session-row-gap)]">
            {load.data.servers.map((server) => (
              <FoundRow
                key={server.id}
                server={server}
                checked={picked.includes(server.id)}
                onChange={(on) => setPicked((current) => (on ? [...current, server.id] : current.filter((id) => id !== server.id)))}
              />
            ))}
          </ul>
        ) : null}
        {load.status === 'ready' && load.data.problems.length > 0 ? (
          <ul aria-label="Not read" className="flex flex-col gap-2 text-sm text-fg-muted">
            {load.data.problems.map((problem) => (
              <li key={problem} className="selectable break-words">
                {problem}
              </li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p role="alert" className="selectable text-base text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </DialogContent>
  );
}
