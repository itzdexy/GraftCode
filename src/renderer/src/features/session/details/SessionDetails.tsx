import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  Box,
  Braces,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  File,
  FileCode2,
  FileImage,
  FileText,
  Folder,
  FolderGit2,
  GitBranch,
  Laptop,
  PanelRight,
  Plug,
  RotateCw,
  Settings2,
  Shrink
} from 'lucide-react';
import type { DiffStatsView } from '@shared/schemas/app';
import type { AgentRun } from '@shared/schemas/agentRuns';
import type { McpServerView } from '@shared/schemas/customize';
import type { BackgroundShellView } from '@shared/schemas/panels';
import type { SessionSummary } from '@shared/schemas/sessions';
import { ConnectorIcon } from '../../../components/ConnectorIcon';
import { Button, IconButton } from '../../../components/Button';
import { Collapse } from '../../../components/Collapse';
import { ContextMenu, ContextMenuCheckItem, ContextMenuContent, ContextMenuLabel, ContextMenuTrigger } from '../../../components/Menu';
import { Spinner } from '../../../components/ContextRing';
import { onChanged } from '../../../lib/bus';
import { connectorName } from '../../../lib/brands';
import { cn } from '../../../lib/cn';
import { formatTokenCount } from '../../../lib/format';
import { invoke } from '../../../lib/ipc';
import { logError } from '../../../lib/log';
import { SLIDE_EXIT_MS, subscribeVisibleClock, usePresence } from '../../../lib/motion';
import { useLoad } from '../../../lib/useLoad';
import { useApp } from '../../../stores/app';
import { useDetails } from '../../../stores/details';
import { useNav } from '../../../stores/nav';
import { panelBus, panelsOf, usePanels } from '../../../stores/panels';
import { reportError, useToasts } from '../../../stores/toasts';
import { ChangeCount, formatCount, GitActions } from '../StatusBar';
import {
  CARD_TITLES,
  connectorRow,
  connectorsSummary,
  contextBreakdown,
  DETAIL_CARDS,
  DETAILS_WIDTH,
  detailsShown,
  elapsedText,
  percentText,
  sessionOutputs,
  taskRows,
  tasksSummary,
  TRANSCRIPT_MIN,
  type ConnectorRow,
  type ContextRow,
  type DetailCard,
  type OutputFile,
  type TaskRow
} from './detailsModel';

// ---- Where it is drawn ----------------------------------------------------------

function subscribeResize(onChange: () => void): () => void {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
}

function useViewportWidth(): number {
  return useSyncExternalStore(subscribeResize, () => window.innerWidth);
}

function useSidebarWidth(): number {
  return useApp((s) => (s.settings?.ui.sidebarCollapsed ? 0 : (s.settings?.ui.sidebarWidth ?? 262)));
}

/** Whether a session's details column is on screen now. */
export function useDetailsShown(sessionId: string): boolean {
  const wanted = useDetails((s) => s.open);
  const panelsOpen = usePanels((s) => panelsOf(s, sessionId).open.length);
  return detailsShown(wanted, panelsOpen, useViewportWidth(), useSidebarWidth());
}

/** The same, read once (the palette asks when it runs a command). */
export function detailsShownNow(sessionId: string): boolean {
  const settings = useApp.getState().settings;
  const sidebar = settings?.ui.sidebarCollapsed ? 0 : (settings?.ui.sidebarWidth ?? 262);
  return detailsShown(useDetails.getState().open, panelsOf(usePanels.getState(), sessionId).open.length, window.innerWidth, sidebar);
}

/**
 * Hides the column, or shows it in the place of the panels: they close, and
 * what runs in them keeps running (a terminal is there again when its panel
 * opens).
 */
export function toggleDetails(sessionId: string, shown: boolean): void {
  if (shown) {
    useDetails.getState().setOpen(false);
    return;
  }
  for (const panel of panelsOf(usePanels.getState(), sessionId).open) usePanels.getState().close(sessionId, panel);
  useDetails.getState().setOpen(true);
}

/** The header button that shows and hides the column. */
export function DetailsToggle({ sessionId }: { sessionId: string }) {
  const shown = useDetailsShown(sessionId);
  const roomy = useViewportWidth() - useSidebarWidth() - DETAILS_WIDTH >= TRANSCRIPT_MIN;
  return (
    <IconButton
      label={roomy ? 'Session details' : 'Session details need a wider window'}
      active={shown}
      aria-pressed={shown}
      disabled={!roomy}
      onClick={() => toggleDetails(sessionId, shown)}
    >
      <PanelRight className="size-16" />
    </IconButton>
  );
}

// ---- A card ---------------------------------------------------------------------

function DetailsCard({ id, title, summary, index, children }: { id: DetailCard; title: string; summary?: ReactNode; index: number; children: ReactNode }) {
  const open = useDetails((s) => !s.folded.includes(id));
  return (
    // A group, not a landmark: "Changes" here and the Changes panel would otherwise be two regions of one name.
    <div role="group" aria-label={title} className="motion-rise shrink-0 rounded-lg border border-border-card bg-raised" style={{ animationDelay: `${String(index * 45)}ms` }}>
      <h2>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => useDetails.getState().fold(id, open)}
          className="group flex min-h-34 w-full items-center gap-6 rounded-lg px-12 text-left transition-ui hover:bg-hover"
        >
          <span className="shrink-0 text-base font-medium text-fg-strong">{title}</span>
          <ChevronRight className={cn('size-12 shrink-0 text-icon transition-transform duration-[var(--g-duration-fast)]', open && 'rotate-90')} aria-hidden="true" />
          <span className="min-w-0 flex-1" />
          {summary ? <span className="flex min-w-0 shrink items-center gap-6 truncate text-sm text-fg-muted">{summary}</span> : null}
        </button>
      </h2>
      <Collapse open={open} className="px-12 pb-10">
        {children}
      </Collapse>
    </div>
  );
}

/** A line of a card: an icon, what it is, and a muted word on it; a button when something can be done with it. */
function Line({ icon, label, detail, title, mono = false, onClick }: { icon: ReactNode; label: string; detail?: string | null; title?: string; mono?: boolean; onClick?: () => void }) {
  const body = (
    <>
      <span className="flex size-16 shrink-0 items-center justify-center text-icon" aria-hidden="true">
        {icon}
      </span>
      <span className={cn('min-w-0 truncate text-md text-fg', mono && 'font-mono text-sm')}>{label}</span>
      {detail ? <span className="min-w-0 flex-1 truncate text-sm text-fg-faint">{detail}</span> : <span className="flex-1" />}
    </>
  );
  return (
    <li>
      {onClick ? (
        <button type="button" title={title} onClick={onClick} className="flex h-26 w-full items-center gap-8 rounded-sm px-4 text-left transition-ui hover:bg-hover">
          {body}
        </button>
      ) : (
        <div title={title} className="flex h-26 items-center gap-8 px-4">
          {body}
        </div>
      )}
    </li>
  );
}

const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;

/** The last two folders of a path, so the line says where without the whole of it. */
function nearPath(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts.length <= 3 ? p : `…${p.includes('\\') ? '\\' : '/'}${parts.slice(-3, -1).join(p.includes('\\') ? '\\' : '/')}`;
}

function reveal(path: string): void {
  invoke('app:revealPath', { path }).catch((error: unknown) => reportError("Couldn't show the folder", error));
}

function copyText(text: string, what: string): void {
  navigator.clipboard.writeText(text).then(
    () => useToasts.getState().push({ tone: 'success', title: `${what} copied` }),
    (error: unknown) => reportError("Couldn't copy to the clipboard", error)
  );
}

// ---- Environment ----------------------------------------------------------------

function EnvironmentCard({ summary, branch, index }: { summary: SessionSummary; branch: string | null; index: number }) {
  const project = summary.projectPath ?? summary.cwd;
  return (
    <DetailsCard id="environment" title="Environment" index={index}>
      <ul className="flex flex-col">
        <Line icon={<Laptop className="size-14" />} label="This computer" />
        {project ? (
          <Line
            icon={<Folder className="size-14" />}
            label={summary.projectName ?? baseName(project)}
            detail={nearPath(project)}
            title={`${project}\nShow in folder`}
            onClick={() => reveal(project)}
          />
        ) : (
          <Line icon={<Folder className="size-14" />} label="No folder" />
        )}
        {summary.worktreePath ? (
          <Line
            icon={<FolderGit2 className="size-14" />}
            label="Worktree"
            detail={baseName(summary.worktreePath)}
            title={`${summary.worktreePath}\nShow in folder`}
            onClick={() => reveal(summary.worktreePath ?? '')}
          />
        ) : null}
        {branch ? <Line icon={<GitBranch className="size-14" />} label={branch} mono title="Copy the branch name" onClick={() => copyText(branch, 'Branch name')} /> : null}
      </ul>
    </DetailsCard>
  );
}

// ---- Context --------------------------------------------------------------------

/** Each part of the context keeps one color, in both themes. */
const PART_COLOR: Record<ContextRow['id'], string> = {
  user: 'var(--g-avatar-1)',
  replies: 'var(--g-avatar-2)',
  results: 'var(--g-avatar-3)',
  reasoning: 'var(--g-avatar-4)',
  tools: 'var(--g-avatar-5)',
  mcp: 'var(--g-avatar-6)',
  system: 'var(--g-avatar-8)'
};

/** The window as one bar: each part grows to its share when it is first drawn, one after another. */
function StackedBar({ rows, label }: { rows: ContextRow[]; label: string }) {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div role="img" aria-label={label} className="mt-6 flex h-6 overflow-hidden rounded-full bg-control">
      {rows.map((row, i) => (
        <span
          key={row.id}
          className="h-full shrink-0 transition-[width] duration-[var(--g-duration-lively,var(--g-duration-slow))] ease-[var(--g-ease-out)]"
          style={{ width: grown ? `${String(row.share * 100)}%` : '0%', background: PART_COLOR[row.id], transitionDelay: `${String(i * 50)}ms` }}
        />
      ))}
    </div>
  );
}

function MiniBar({ share }: { share: number }) {
  return (
    <span aria-hidden="true" className="inline-flex h-4 w-32 shrink-0 overflow-hidden rounded-full bg-control">
      <span className="h-full rounded-full bg-blue transition-[width] duration-[var(--g-duration-slow)]" style={{ width: `${String(Math.min(100, share * 100))}%` }} />
    </span>
  );
}

function ContextCard({ summary, limit, busy, empty, refreshKey, onCompact, index }: { summary: SessionSummary; limit: number; busy: boolean; empty: boolean; refreshKey: string; onCompact: () => void; index: number }) {
  const folded = useDetails((s) => s.folded.includes('context'));
  const autoCompact = useApp((s) => s.settings?.behavior.autoCompact ?? true);
  // Worked out again when the card opens and when a turn ends: the parts change with every step.
  const { load } = useLoad(() => (folded ? Promise.resolve(null) : invoke('sessions:context', { id: summary.id })), folded ? 'folded' : refreshKey);
  const used = summary.usage.contextTokens;
  const share = limit > 0 ? used / limit : 0;
  const report = load.status === 'ready' ? load.data : null;
  const b = report ? contextBreakdown(report, used, limit || report.limit, autoCompact) : null;
  return (
    <DetailsCard
      id="context"
      title="Context"
      index={index}
      summary={
        <>
          <span className="tabular-nums">{percentText(share)}</span>
          <MiniBar share={share} />
        </>
      }
    >
      {b ? (
        <>
          <div className="flex items-baseline justify-between gap-8">
            <span className="text-md font-medium text-fg-strong">{percentText(b.share)} used</span>
            <span className="text-sm text-fg-muted tabular-nums">
              {formatTokenCount(b.used)} / {b.limit > 0 ? formatTokenCount(b.limit) : '?'}
            </span>
          </div>
          <StackedBar rows={b.rows} label={`${percentText(b.share)} of the context window is used`} />
          <ul className="mt-8 flex flex-col gap-2">
            {b.rows.map((row) => (
              <li key={row.id} className="flex items-center gap-8 text-sm">
                <span aria-hidden="true" className="size-8 shrink-0 rounded-[2px]" style={{ background: PART_COLOR[row.id] }} />
                <span className="min-w-0 flex-1 truncate text-fg-secondary">{row.label}</span>
                <span className="shrink-0 text-fg-muted tabular-nums">{formatTokenCount(row.tokens)}</span>
                <span className="w-40 shrink-0 text-right text-fg-secondary tabular-nums">{percentText(row.share)}</span>
              </li>
            ))}
            {b.limit > 0 ? (
              <li className="flex items-center gap-8 text-sm">
                <span aria-hidden="true" className="size-8 shrink-0 rounded-[2px] border border-border-strong" />
                <span className="min-w-0 flex-1 truncate text-fg-muted">Free space</span>
                <span className="shrink-0 text-fg-muted tabular-nums">{formatTokenCount(b.free)}</span>
                <span className="w-40 shrink-0 text-right text-fg-muted tabular-nums">{percentText(b.freeShare)}</span>
              </li>
            ) : null}
          </ul>
          <div className="mt-10 flex items-center gap-8">
            <p className="min-w-0 flex-1 text-sm text-fg-muted">
              {b.untilCompact === null
                ? autoCompact
                  ? 'Window size unknown'
                  : 'Automatic compaction is off'
                : b.untilCompact === 0
                  ? 'Graft compacts before the next request'
                  : `About ${formatTokenCount(b.untilCompact)} until Graft compacts`}
            </p>
            <Button size="sm" variant="secondary" leading={<Shrink className="size-12" />} disabled={busy || empty} onClick={onCompact}>
              Compact session
            </Button>
          </div>
          <p className="mt-6 text-xs text-fg-faint">Estimated from the text. Refreshes when a turn ends.</p>
        </>
      ) : load.status === 'error' ? (
        <p role="alert" className="text-sm text-fg-muted">
          Couldn't work out what fills it.
        </p>
      ) : (
        <p role="status" className="flex items-center gap-6 text-sm text-fg-muted">
          <Spinner size={12} label="Working it out" /> Working it out…
        </p>
      )}
    </DetailsCard>
  );
}

// ---- Connectors -----------------------------------------------------------------

const SHOWN_CONNECTORS = 5;

function ConnectorAction({ row }: { row: ConnectorRow }) {
  const [busy, setBusy] = useState(false);
  if (row.action === null) return null;
  const run = (): void => {
    if (row.action === 'review') {
      useNav.getState().go({ name: 'customize', tab: 'mcp' });
      return;
    }
    setBusy(true);
    invoke(row.action === 'reconnect' ? 'mcp:reconnect' : 'mcp:authorize', { name: row.name })
      .catch((error: unknown) => reportError(row.action === 'reconnect' ? `Couldn't reconnect ${row.name}` : `Couldn't sign in to ${row.name}`, error))
      .finally(() => setBusy(false));
  };
  return (
    <button
      type="button"
      disabled={busy}
      onClick={run}
      aria-label={`${row.action === 'reconnect' ? 'Reconnect' : row.action === 'sign-in' ? 'Sign in to' : 'Review'} ${row.name}`}
      className="inline-flex h-22 shrink-0 items-center gap-4 rounded-sm px-6 text-sm text-amber-fg transition-ui hover:bg-hover disabled:text-fg-faint"
    >
      {busy ? <Spinner size={10} label="Working" /> : null}
      {row.action === 'reconnect' ? 'Reconnect' : row.action === 'sign-in' ? 'Sign in' : 'Review'}
    </button>
  );
}

/** Where a server runs, in a few words: the address of a remote one, the command of one on this computer. */
function whereItRuns(server: McpServerView): string {
  if (server.config.type === 'http') {
    try {
      return `Remote · ${new URL(server.config.url).host}`;
    } catch {
      return 'Remote';
    }
  }
  const command = [server.config.command, ...server.config.args].join(' ');
  return `On this computer · ${command.length > 60 ? `${command.slice(0, 59)}…` : command}`;
}

const SHOWN_TOOLS = 10;

/** One connector: its app's mark with a dot for its state, its name, what it offers; it opens to the rest. */
function ConnectorItem({ server, row }: { server: McpServerView; row: ConnectorRow }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = connectorName(server);
  const reconnect = (): void => {
    setBusy(true);
    invoke('mcp:reconnect', { name: server.name })
      .catch((error: unknown) => reportError(`Couldn't reconnect ${name}`, error))
      .finally(() => setBusy(false));
  };
  return (
    <li className="motion-rise rounded-md transition-ui hover:bg-hover/60">
      <div className="flex min-h-34 items-center gap-8 px-4">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${name}: ${row.status}`}
          title={server.name === name ? undefined : server.name}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-8 py-4 text-left"
        >
          <ConnectorIcon server={server} size={22} state={server.state} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-md text-fg">{name}</span>
            <span className={cn('block truncate text-xs', row.action ? 'text-amber-fg' : 'text-fg-muted')}>{row.status}</span>
          </span>
          <ChevronRight className={cn('size-12 shrink-0 text-icon transition-transform duration-[var(--g-duration-fast)]', open && 'rotate-90')} aria-hidden="true" />
        </button>
        <ConnectorAction row={row} />
      </div>
      <Collapse open={open} className="px-4 pb-8 pl-34">
        <p className="truncate font-mono text-2xs text-fg-faint" title={whereItRuns(server)}>
          {whereItRuns(server)}
          {server.version ? ` · v${server.version}` : ''}
        </p>
        {server.error && server.state !== 'connected' ? <p className="mt-4 text-xs text-amber-fg">{server.error}</p> : null}
        {server.hint ? <p className="mt-4 text-xs text-fg-muted">{server.hint}</p> : null}
        {server.tools.length > 0 ? (
          <ul aria-label={`Tools of ${name}`} className="mt-6 flex flex-wrap gap-4">
            {server.tools.slice(0, SHOWN_TOOLS).map((tool) => (
              <li key={tool.name} title={tool.description || tool.name} className="max-w-full truncate rounded-xs bg-control px-6 py-1 font-mono text-2xs text-fg-secondary">
                {tool.name}
              </li>
            ))}
            {server.tools.length > SHOWN_TOOLS ? <li className="px-2 py-1 text-2xs text-fg-muted">+{String(server.tools.length - SHOWN_TOOLS)} more</li> : null}
          </ul>
        ) : null}
        <div className="mt-6 flex flex-wrap items-center gap-6">
          {/* A server that needs a hand has its button on its line already. */}
          {row.action === null && server.state !== 'disabled' ? (
            <Button size="sm" variant="ghost" disabled={busy} leading={busy ? <Spinner size={10} label="Reconnecting" /> : <RotateCw className="size-12" />} onClick={reconnect}>
              Reconnect
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" leading={<Settings2 className="size-12" />} onClick={() => useNav.getState().go({ name: 'customize', tab: 'mcp' })}>
            Open in Customize
          </Button>
        </div>
      </Collapse>
    </li>
  );
}

function ConnectorsCard({ projectPath, index }: { projectPath: string | null; index: number }) {
  const { load, reload } = useLoad(() => invoke('mcp:list', { projectPath }), projectPath ?? '');
  useEffect(() => onChanged('mcp', reload), [reload]);
  const [all, setAll] = useState(false);
  const servers = load.status === 'ready' ? load.data : [];
  const items = servers.map((server) => ({ server, row: connectorRow(server) }));
  // What needs a hand comes first, then what is connected.
  const ordered = [...items].sort(
    (a, b) => Number(b.row.action !== null) - Number(a.row.action !== null) || Number(b.server.state === 'connected') - Number(a.server.state === 'connected')
  );
  const shown = all ? ordered : ordered.slice(0, SHOWN_CONNECTORS);
  const manage = (): void => useNav.getState().go({ name: 'customize', tab: 'mcp' });
  return (
    <DetailsCard
      id="connectors"
      title="Connectors"
      index={index}
      summary={
        load.status === 'ready' ? (
          <>
            {servers.length > 0 ? (
              <span aria-hidden="true" className="flex shrink-0 -space-x-4">
                {ordered.slice(0, 4).map(({ server }) => (
                  <ConnectorIcon key={server.name} server={server} size={16} className="rounded-[5px] ring-2 ring-[var(--g-surface-raised)]" />
                ))}
              </span>
            ) : null}
            <span className="truncate">{connectorsSummary(items.map((item) => item.row))}</span>
          </>
        ) : null
      }
    >
      {load.status === 'loading' ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading…
        </p>
      ) : load.status === 'error' ? (
        <p role="alert" className="text-sm text-fg-muted">
          Couldn't list the connectors.
        </p>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-start gap-6">
          <p className="text-sm text-fg-muted">No connectors yet. Blender, Roblox Studio, Figma and other tools join through MCP.</p>
          <Button size="sm" variant="secondary" leading={<Plug className="size-12" />} onClick={manage}>
            Add a connector
          </Button>
        </div>
      ) : (
        <>
          <ul className="-mx-4 flex flex-col gap-1">
            {shown.map(({ server, row }) => (
              <ConnectorItem key={server.name} server={server} row={row} />
            ))}
          </ul>
          <div className="mt-4 flex items-center gap-8">
            {ordered.length > shown.length ? (
              <button type="button" onClick={() => setAll(true)} className="text-sm text-fg-muted transition-ui hover:text-fg">
                Show {String(ordered.length - shown.length)} more
              </button>
            ) : null}
            <span className="flex-1" />
            <button type="button" onClick={manage} className="text-sm text-link transition-ui hover:underline">
              Manage
            </button>
          </div>
        </>
      )}
    </DetailsCard>
  );
}

// ---- Outputs --------------------------------------------------------------------

const SHOWN_OUTPUTS = 8;

function outputIcon(name: string): ReactNode {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'].includes(ext)) return <FileImage className="size-14" />;
  if (['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply'].includes(ext)) return <Box className="size-14" />;
  if (['json', 'yaml', 'yml', 'toml'].includes(ext)) return <Braces className="size-14" />;
  if (['md', 'txt', 'rst'].includes(ext)) return <FileText className="size-14" />;
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'py', 'rs', 'go', 'lua', 'luau', 'cs', 'cpp', 'c', 'h', 'java', 'kt', 'swift', 'rb', 'php', 'html', 'css', 'sh', 'ps1'].includes(ext))
    return <FileCode2 className="size-14" />;
  return <File className="size-14" />;
}

function OutputsCard({ sessionId, outputs, index }: { sessionId: string; outputs: OutputFile[]; index: number }) {
  const [all, setAll] = useState(false);
  if (outputs.length === 0) return null;
  const shown = all ? outputs : outputs.slice(0, SHOWN_OUTPUTS);
  const open = (file: OutputFile): void => {
    if (file.where === 'project') usePanels.getState().openFile(sessionId, file.path);
    else invoke('chatFiles:open', { sessionId, name: file.path }).catch((error: unknown) => reportError(`Couldn't open ${file.name}`, error));
  };
  return (
    <DetailsCard id="outputs" title="Outputs" index={index} summary={<span className="tabular-nums">{outputs.length}</span>}>
      <ul className="flex flex-col">
        {shown.map((file) => {
          const dir = file.path.length > file.name.length ? file.path.slice(0, file.path.length - file.name.length - 1) : null;
          return (
            <li key={`${file.where}:${file.path}`} className="motion-rise">
              <button
                type="button"
                title={`Open ${file.path}`}
                onClick={() => open(file)}
                className="flex h-26 w-full items-center gap-8 rounded-sm px-4 text-left transition-ui hover:bg-hover"
              >
                <span className="flex size-16 shrink-0 items-center justify-center text-icon" aria-hidden="true">
                  {outputIcon(file.name)}
                </span>
                <span className="min-w-0 truncate text-md text-fg">{file.name}</span>
                {dir ? <span className="min-w-0 flex-1 truncate text-right text-xs text-fg-faint">{dir}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      {outputs.length > shown.length ? (
        <button type="button" onClick={() => setAll(true)} className="mt-2 px-4 text-sm text-fg-muted transition-ui hover:text-fg">
          Show {String(outputs.length - shown.length)} more
        </button>
      ) : null}
    </DetailsCard>
  );
}

// ---- Background tasks -----------------------------------------------------------

const SHOWN_TASKS = 5;

function TaskMark({ state }: { state: TaskRow['state'] }) {
  if (state === 'running') return <span aria-label="Running" role="img" className="motion-pulse size-8 rounded-full bg-blue" />;
  if (state === 'done') return <CircleCheck aria-label="Done" className="size-13 text-success" />;
  if (state === 'failed') return <CircleAlert aria-label="Failed" className="size-13 text-danger" />;
  return <CircleSlash aria-label="Stopped" className="size-13 text-fg-faint" />;
}

function TasksCard({ sessionId, runs, index }: { sessionId: string; runs: AgentRun[]; index: number }) {
  const [shells, setShells] = useState<BackgroundShellView[]>([]);
  useEffect(() => {
    let current = true;
    const load = (): void => {
      invoke('shells:list', { sessionId })
        .then((list) => current && setShells(list))
        .catch((error: unknown) => logError('Could not list background commands', error));
    };
    load();
    const stop = panelBus.onShellsChanged(sessionId, load);
    return () => {
      current = false;
      stop();
    };
  }, [sessionId]);
  const rows = useMemo(() => taskRows(shells, runs), [shells, runs]);
  const running = rows.some((row) => row.state === 'running');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => (running ? subscribeVisibleClock(() => setNow(Date.now())) : undefined), [running]);
  if (rows.length === 0) return null;
  const shown = rows.slice(0, SHOWN_TASKS);
  const show = (row: TaskRow): void => usePanels.getState().show(sessionId, row.kind === 'agent' ? 'agents' : 'tasks');
  return (
    <DetailsCard id="tasks" title="Background tasks" index={index} summary={tasksSummary(rows)}>
      <ul className="flex flex-col">
        {shown.map((row) => (
          <li key={row.key} className="motion-rise">
            <button
              type="button"
              title={row.kind === 'agent' ? `${row.title}\nOpen the Agents panel` : `${row.title}\nOpen Background tasks`}
              onClick={() => show(row)}
              className="flex min-h-30 w-full items-center gap-8 rounded-sm px-4 text-left transition-ui hover:bg-hover"
            >
              <span className="flex size-16 shrink-0 items-center justify-center">
                <TaskMark state={row.state} />
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-fg', row.kind === 'command' ? 'font-mono text-sm' : 'text-md')}>{row.title}</span>
                {row.note ? <span className="block truncate text-xs text-fg-muted">{row.note}</span> : null}
              </span>
              <span className="shrink-0 text-sm text-fg-muted tabular-nums">{elapsedText((row.endedAt ?? now) - row.startedAt)}</span>
            </button>
          </li>
        ))}
      </ul>
      {rows.length > shown.length ? (
        <button type="button" onClick={() => usePanels.getState().show(sessionId, 'tasks')} className="mt-2 px-4 text-sm text-fg-muted transition-ui hover:text-fg">
          {String(rows.length - shown.length)} more in Background tasks
        </button>
      ) : null}
    </DetailsCard>
  );
}

// ---- Changes --------------------------------------------------------------------

function ChangesCard({ summary, stats, onChanged, index }: { summary: SessionSummary; stats: DiffStatsView | null; onChanged: () => void; index: number }) {
  if (!stats?.branch) return null;
  const any = stats.added > 0 || stats.removed > 0;
  const review = (): void => {
    usePanels.getState().setChangesTab(summary.id, 'changes');
    usePanels.getState().show(summary.id, 'changes');
  };
  return (
    <DetailsCard
      id="changes"
      title="Changes"
      index={index}
      summary={
        any ? (
          <span className="font-mono tabular-nums">
            <span className="text-diff-add">+{formatCount(stats.added)}</span> <span className="text-diff-del">−{formatCount(stats.removed)}</span>
          </span>
        ) : (
          'None yet'
        )
      }
    >
      {any ? (
        <p className="flex items-center gap-8">
          <ChangeCount added={stats.added} removed={stats.removed} />
          <span className="text-sm text-fg-muted">{stats.files === 1 ? 'in 1 file' : `in ${formatCount(stats.files)} files`}</span>
        </p>
      ) : (
        <p className="text-sm text-fg-muted">Nothing changed on {stats.branch} yet.</p>
      )}
      <div className="mt-8 flex flex-wrap items-center gap-6">
        {any ? (
          <Button size="sm" variant="secondary" onClick={review}>
            Review
          </Button>
        ) : null}
        <GitActions summary={summary} branch={stats.branch} onChanged={onChanged} side="bottom" />
      </div>
    </DetailsCard>
  );
}

// ---- The column -----------------------------------------------------------------

export interface DetailsColumnProps {
  summary: SessionSummary;
  messages: Parameters<typeof sessionOutputs>[0];
  runs: AgentRun[];
  /** The selected model's context window (the summary's until the models load). */
  limit: number;
  stats: DiffStatsView | null;
  busy: boolean;
  /** Changes when a turn ends or a message arrives: the context is worked out again then. */
  refreshKey: string;
  shown: boolean;
  onCompact: () => void;
  onStatsChanged: () => void;
}

/**
 * A code session's details beside the conversation: where it runs, what
 * fills its context, its connectors, the files it made, what runs in the
 * background and what it changed. It slides in and out like the panels, whose
 * place it takes.
 */
export function DetailsColumn({ summary, messages, runs, limit, stats, busy, refreshKey, shown, onCompact, onStatsChanged }: DetailsColumnProps) {
  const present = usePresence(shown, SLIDE_EXIT_MS);
  const outputs = useMemo(() => sessionOutputs(messages), [messages]);
  const hidden = useDetails((s) => s.hidden);
  const shows = (card: DetailCard): boolean => !hidden.includes(card);
  return (
    <div className="graft-slide-x graft-slide-x--flush h-full shrink-0" data-state={shown ? 'open' : 'closed'}>
      <div>
        {present ? (
          // A right-click anywhere on the column chooses its cards, as the Claude desktop app's session rail does.
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <aside aria-label="Session details" className="flex h-full flex-col gap-8 overflow-y-auto py-8 pr-8 pl-2" style={{ width: DETAILS_WIDTH }}>
                {shows('environment') ? <EnvironmentCard summary={summary} branch={stats?.branch ?? null} index={0} /> : null}
                {shows('context') ? (
                  <ContextCard summary={summary} limit={limit} busy={busy} empty={messages.length === 0} refreshKey={refreshKey} onCompact={onCompact} index={1} />
                ) : null}
                {shows('connectors') ? <ConnectorsCard projectPath={summary.projectPath} index={2} /> : null}
                {shows('outputs') ? <OutputsCard sessionId={summary.id} outputs={outputs} index={3} /> : null}
                {shows('tasks') ? <TasksCard sessionId={summary.id} runs={runs} index={4} /> : null}
                {shows('changes') ? <ChangesCard summary={summary} stats={stats} onChanged={onStatsChanged} index={5} /> : null}
                {hidden.length === DETAIL_CARDS.length ? (
                  <div className="motion-rise flex flex-col items-start gap-6 px-8 py-6">
                    <p className="text-sm text-fg-muted">Every card is taken out. A right-click here chooses the cards.</p>
                    <Button size="sm" variant="secondary" onClick={() => DETAIL_CARDS.forEach((card) => useDetails.getState().showCard(card, true))}>
                      Show all cards
                    </Button>
                  </div>
                ) : null}
              </aside>
            </ContextMenuTrigger>
            <ContextMenuContent className="min-w-[200px]">
              <ContextMenuLabel>Cards in this column</ContextMenuLabel>
              {DETAIL_CARDS.map((card) => (
                <ContextMenuCheckItem key={card} checked={shows(card)} onCheckedChange={(on) => useDetails.getState().showCard(card, on)}>
                  {CARD_TITLES[card]}
                </ContextMenuCheckItem>
              ))}
            </ContextMenuContent>
          </ContextMenu>
        ) : null}
      </div>
    </div>
  );
}
