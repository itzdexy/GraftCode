import { tokensUntilCompact } from '@shared/compaction';
import type { AgentRun } from '@shared/schemas/agentRuns';
import { agentRunActive } from '@shared/schemas/agentRuns';
import type { McpServerView } from '@shared/schemas/customize';
import type { StoredMessage } from '@shared/schemas/messages';
import type { BackgroundShellView } from '@shared/schemas/panels';
import type { ContextPart, ContextReport } from '@shared/schemas/sessions';
import { serverSummary } from '../../customize/mcpModel';

/**
 * What the session details column shows, worked out from what the session
 * already knows: its context, its connectors, the files its tools made, its
 * background work. Pure, so it is unit-tested without a DOM.
 */

export const DETAIL_CARDS = ['environment', 'context', 'connectors', 'outputs', 'tasks', 'changes'] as const;
export type DetailCard = (typeof DETAIL_CARDS)[number];

/** Each card's name, as its header and the column's right-click menu say it. */
export const CARD_TITLES: Record<DetailCard, string> = {
  environment: 'Environment',
  context: 'Context',
  connectors: 'Connectors',
  outputs: 'Outputs',
  tasks: 'Background tasks',
  changes: 'Changes'
};

/** Folded when nothing was said yet: the two whose one-line summary says most of what they hold. */
export const FOLDED_AT_FIRST: readonly DetailCard[] = ['context', 'connectors'];

/** The column's width, and the room the conversation keeps beside it. */
export const DETAILS_WIDTH = 288;
export const TRANSCRIPT_MIN = 420;

/**
 * Where a folder is, for the line beside its name: the folder it is in, or the last two names of that path when it
 * is longer (`…\Local\Temp`). Never the folder itself, whose name is beside it already.
 */
export function nearPath(p: string): string {
  const sep = p.includes('\\') ? '\\' : '/';
  const parent = p.replace(/[\\/]+$/, '').split(/[\\/]/).slice(0, -1);
  if (parent.filter((name) => name.length > 0).length > 2) return `…${sep}${parent.slice(-2).join(sep)}`;
  const shown = parent.join(sep);
  // A root is written with its separator: "/" and "C:\", not "" and "C:".
  return shown.length === 0 || shown.endsWith(':') ? `${shown}${sep}` : shown;
}

/** Whether the column is drawn: asked for, no panel in its place, and room for the conversation beside it. */
export function detailsShown(wanted: boolean, panelsOpen: number, viewport: number, sidebar: number): boolean {
  return wanted && panelsOpen === 0 && viewport - sidebar - DETAILS_WIDTH >= TRANSCRIPT_MIN;
}

// ---- Context --------------------------------------------------------------------

export interface ContextRow {
  id: ContextPart['id'];
  label: string;
  tokens: number;
  /** Of the whole window. */
  share: number;
}

export interface ContextBreakdown {
  used: number;
  limit: number;
  /** Of the whole window, 0 to 1. */
  share: number;
  rows: ContextRow[];
  free: number;
  freeShare: number;
  /** Tokens before Graft compacts by itself; null when it won't (switched off) or can't tell (window unknown). */
  untilCompact: number | null;
}

/**
 * The window part by part. The parts are estimated from the text; the total
 * is the session's own count after its last request (the number the ring
 * under the message box shows), else the provider's count of the request,
 * else the estimate. The parts are scaled to the total, so the bar adds up
 * to the number written above it.
 */
export function contextBreakdown(report: ContextReport | null, counted: number, limit: number, autoCompact: boolean): ContextBreakdown {
  const parts = (report?.parts ?? []).filter((part) => part.tokens > 0);
  const estimated = parts.reduce((sum, part) => sum + part.tokens, 0);
  const used = counted > 0 ? counted : (report?.measured ?? estimated);
  const scale = estimated > 0 ? used / estimated : 0;
  const of = (tokens: number): number => (limit > 0 ? Math.min(1, tokens / limit) : 0);
  const rows = parts
    .map((part) => ({ id: part.id, label: part.label, tokens: Math.round(part.tokens * scale) }))
    .sort((a, b) => b.tokens - a.tokens)
    .map((row) => ({ ...row, share: of(row.tokens) }));
  const free = limit > 0 ? Math.max(0, limit - used) : 0;
  return { used, limit, share: of(used), rows, free, freeShare: of(free), untilCompact: autoCompact ? tokensUntilCompact(used, limit) : null };
}

/** A share of the window as people say it: "8%", "0.4%", "<0.1%". */
export function percentText(share: number): string {
  const pct = share * 100;
  if (pct === 0) return '0%';
  if (pct < 0.1) return '<0.1%';
  if (pct < 10) return `${pct.toFixed(1).replace(/\.0$/, '')}%`;
  return `${String(Math.round(pct))}%`;
}

// ---- Connectors -----------------------------------------------------------------

export type ConnectorAction = 'reconnect' | 'sign-in' | 'review' | null;

export interface ConnectorRow {
  name: string;
  state: McpServerView['state'];
  status: string;
  action: ConnectorAction;
}

/** A server as its row shows it, in the words Customize uses, with the one thing to do about it when there is one. */
export function connectorRow(server: McpServerView): ConnectorRow {
  const action: ConnectorAction = server.state === 'failed' ? 'reconnect' : server.state === 'needs-auth' ? 'sign-in' : server.state === 'untrusted' ? 'review' : null;
  return { name: server.name, state: server.state, status: serverSummary(server), action };
}

/** The card's one line: what needs a hand first, then how many are connected. */
export function connectorsSummary(rows: ConnectorRow[]): string {
  if (rows.length === 0) return 'None';
  const waiting = rows.filter((row) => row.action !== null).length;
  if (waiting > 0) return waiting === 1 ? '1 needs you' : `${String(waiting)} need you`;
  const connected = rows.filter((row) => row.state === 'connected').length;
  return `${String(connected)} of ${String(rows.length)} connected`;
}

// ---- Outputs --------------------------------------------------------------------

export interface OutputFile {
  /** The path in the session's folder, or the name of a file a chat keeps. */
  path: string;
  name: string;
  /** Where it lives: the session's folder, or the files a chat keeps. */
  where: 'project' | 'chat';
}

const nameOf = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);

/**
 * The files the session's tools made, first made first: a file a tool
 * created, a file a chat saved, a picture or clip a generator wrote. Edits to
 * a file that was there before are changes, not outputs.
 */
export function sessionOutputs(messages: StoredMessage[]): OutputFile[] {
  const seen = new Map<string, OutputFile>();
  const add = (file: OutputFile): void => {
    const key = `${file.where}:${file.path.replace(/\\/g, '/')}`;
    if (!seen.has(key)) seen.set(key, file);
  };
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'tool_result' || block.isError || !block.display) continue;
      const display = block.display;
      if (display.kind === 'edit' && display.created) add({ path: display.path, name: nameOf(display.path), where: 'project' });
      else if (display.kind === 'file') add({ path: display.name, name: display.name, where: 'chat' });
      else if (display.kind === 'media') for (const file of display.files) add({ path: file.path, name: nameOf(file.path), where: 'project' });
    }
  }
  return [...seen.values()];
}

// ---- Background tasks -----------------------------------------------------------

export type TaskState = 'running' | 'done' | 'failed' | 'stopped';

export interface TaskRow {
  key: string;
  kind: 'command' | 'agent';
  title: string;
  state: TaskState;
  startedAt: number;
  endedAt: number | null;
  /** What else is worth a glance: the model of an agent, the exit code of a command. */
  note: string | null;
}

function shellState(shell: BackgroundShellView): TaskState {
  if (shell.status === 'running') return 'running';
  if (shell.status === 'killed') return 'stopped';
  return shell.status === 'failed' || (shell.exitCode !== null && shell.exitCode !== 0) ? 'failed' : 'done';
}

function runState(run: AgentRun): TaskState {
  if (agentRunActive(run.status)) return 'running';
  if (run.status === 'failed') return 'failed';
  return run.status === 'done' ? 'done' : 'stopped';
}

/** Background commands and agents together: what is still going first, then the newest. */
export function taskRows(shells: BackgroundShellView[], runs: AgentRun[]): TaskRow[] {
  const rows: TaskRow[] = [
    ...shells.map((shell) => ({
      key: `command:${shell.id}`,
      kind: 'command' as const,
      title: shell.command,
      state: shellState(shell),
      startedAt: shell.startedAt,
      endedAt: shell.endedAt,
      note: shell.status !== 'running' && shell.exitCode !== null && shell.exitCode !== 0 ? `exit ${String(shell.exitCode)}` : null
    })),
    ...runs.map((run) => ({
      key: `agent:${run.id}`,
      kind: 'agent' as const,
      title: run.title || run.roleLabel,
      state: runState(run),
      startedAt: run.startedAt ?? run.createdAt,
      endedAt: run.endedAt,
      note: run.model?.label ?? null
    }))
  ];
  return rows.sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || b.startedAt - a.startedAt);
}

/** How long something ran: "45s", "3m 12s", "1h 4m". */
export function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}

/** The card's one line. */
export function tasksSummary(rows: TaskRow[]): string {
  const running = rows.filter((row) => row.state === 'running').length;
  if (running > 0) return `${String(running)} running`;
  return rows.length === 1 ? '1 finished' : `${String(rows.length)} finished`;
}
