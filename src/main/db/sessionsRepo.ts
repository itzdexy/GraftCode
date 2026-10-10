import { randomUUID } from 'node:crypto';
import { GraftError } from '@shared/errors';
import type { EffortLevel, ModelRef, PermissionMode } from '@shared/schemas/common';
import { EMPTY_USAGE } from '@shared/schemas/common';
import {
  type ContentBlock,
  type MessageMeta,
  type StoredMessage,
  textOf
} from '@shared/schemas/messages';
import type {
  ErrorInfo,
  SessionKind,
  SessionStatus,
  SessionSummary,
  SessionUsage
} from '@shared/schemas/sessions';
import type { TodoItem } from '@shared/schemas/toolDisplay';
import { agentRunActive, type AgentRun } from '@shared/schemas/agentRuns';
import type { Mission } from '@shared/schemas/missions';
import type { UsageDay, UsageEntry } from '@shared/usage';
import { recoverMission } from '../agent/mission';
import { parseJson, type Db } from './database';

/** An agent's record as it is used today: one written by an earlier version gets what has been added since. */
function storedAgentRun(data: string): AgentRun {
  const run = parseJson<Omit<AgentRun, 'writes'> & { writes?: string[] }>(data, 'agent run');
  return { ...run, writes: run.writes ?? [] };
}

export const EMPTY_SESSION_USAGE: SessionUsage = { totals: EMPTY_USAGE, contextTokens: 0, contextLimit: 0, costUsd: null };

export interface CreateSessionInput {
  kind: SessionKind;
  title: string;
  projectId: string | null;
  cwd: string | null;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  model: ModelRef | null;
  effort: EffortLevel | null;
  permissionMode: PermissionMode;
}

export interface SessionPatch {
  title?: string;
  status?: SessionStatus;
  pinned?: boolean;
  archived?: boolean;
  unread?: boolean;
  lastError?: ErrorInfo | null;
  usage?: SessionUsage;
  todos?: TodoItem[];
  model?: ModelRef | null;
  effort?: EffortLevel | null;
  permissionMode?: PermissionMode;
  cwd?: string | null;
  worktreePath?: string | null;
  branch?: string | null;
  baseBranch?: string | null;
  projectId?: string | null;
}

/** Persistence used by the agent runtime; implemented by SQLite and in memory (incognito, tests). */
export interface SessionStore {
  getPruneBeforeSeq(sessionId: string): number;
  setPruneBeforeSeq(sessionId: string, seq: number): void;
  getSummary(sessionId: string): SessionSummary;
  updateSession(sessionId: string, patch: SessionPatch): SessionSummary;
  getTodos(sessionId: string): TodoItem[];
  appendMessage(sessionId: string, role: 'user' | 'assistant', content: ContentBlock[], meta: MessageMeta, id?: string): StoredMessage;
  listMessages(sessionId: string): StoredMessage[];
  getMessage(messageId: string): StoredMessage | null;
  updateMessageMeta(messageId: string, patch: Partial<MessageMeta>): StoredMessage;
  /**
   * Marks messages as replaced: kept for display, not sent to models. `by` is the message that
   * stands for them (a summary, or the note /clear left).
   */
  markCompacted(sessionId: string, messageIds: string[], by?: string): void;
  /** Brings back the messages the given messages replaced (a rewind removed those). Returns how many. */
  restoreCompacted(sessionId: string, by: string[]): number;
  /** Deletes messages with seq >= fromSeq; returns them (for rewind). */
  deleteMessagesFrom(sessionId: string, fromSeq: number): StoredMessage[];
  /** Stores an agent of a group (RunAgents), replacing its earlier state. */
  saveAgentRun(run: AgentRun): void;
  /** A session's agents, oldest group first, in the order each group listed them. */
  listAgentRuns(sessionId: string): AgentRun[];
  /** Removes the agents of groups started at or after a time (a rewind took their turn away). */
  deleteAgentRunsFrom(sessionId: string, fromTime: number): void;
  /** Stores a mission, replacing its earlier state. */
  saveMission(mission: Mission): void;
  /** A session's newest mission, or null when it never had one. */
  getMission(sessionId: string): Mission | null;
  /** Removes the missions started at or after a time (a rewind took their turn away). */
  deleteMissionsFrom(sessionId: string, fromTime: number): void;
  /** Adds a request, or what a tool paid for, to its day's total for its model. */
  recordUsage(entry: UsageEntry): void;
  /** What was used on `fromDay` and after, by day and model, oldest day first. */
  usageSince(fromDay: string): UsageDay[];
}

interface SessionRow {
  id: string;
  kind: SessionKind;
  title: string;
  project_id: string | null;
  project_path: string | null;
  project_name: string | null;
  cwd: string | null;
  worktree_path: string | null;
  branch: string | null;
  base_branch: string | null;
  provider_id: string | null;
  model_id: string | null;
  effort: string | null;
  permission_mode: string;
  status: string;
  pinned: number;
  archived: number;
  unread: number;
  last_error: string | null;
  usage: string;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  meta: string;
  created_at: number;
}

const SESSION_SELECT = `
SELECT s.*, p.path AS project_path, p.name AS project_name
FROM sessions s LEFT JOIN projects p ON p.id = s.project_id`;

function toSummary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    status: row.status as SessionStatus,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    unread: row.unread === 1,
    incognito: false,
    projectId: row.project_id,
    projectPath: row.project_path,
    projectName: row.project_name,
    cwd: row.cwd,
    worktreePath: row.worktree_path,
    branch: row.branch,
    baseBranch: row.base_branch,
    model: row.provider_id && row.model_id ? { providerId: row.provider_id, modelId: row.model_id } : null,
    effort: (row.effort as EffortLevel | null) ?? null,
    permissionMode: row.permission_mode as PermissionMode,
    lastError: row.last_error ? parseJson<ErrorInfo>(row.last_error, 'session error') : null,
    usage: parseJson<SessionUsage>(row.usage, 'session usage'),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    role: row.role,
    content: parseJson<ContentBlock[]>(row.content, 'message content'),
    meta: parseJson<MessageMeta>(row.meta, 'message meta'),
    createdAt: row.created_at
  };
}

const SEARCH_BODY_LIMIT = 20_000;

export interface SearchHit {
  sessionId: string;
  messageId: string | null;
  snippet: string;
}

/** FTS5 phrase query: quotes are doubled so user input is always literal. */
export function ftsPhrase(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

export class SessionsRepo implements SessionStore {
  constructor(private readonly db: Db) {}

  getPruneBeforeSeq(sessionId: string): number {
    this.getSummary(sessionId);
    return (this.db.prepare('SELECT prune_before_seq AS seq FROM sessions WHERE id = ?').get(sessionId) as { seq: number }).seq;
  }

  setPruneBeforeSeq(sessionId: string, seq: number): void {
    this.getSummary(sessionId);
    if (!Number.isSafeInteger(seq) || seq < 0) throw new GraftError('invalid_context_state', 'The pruning cutoff must be a nonnegative integer.');
    this.db.prepare('UPDATE sessions SET prune_before_seq = ? WHERE id = ?').run(seq, sessionId);
  }

  create(input: CreateSessionInput): SessionSummary {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id, kind, title, project_id, cwd, worktree_path, branch, base_branch, provider_id, model_id,
          effort, permission_mode, status, usage, created_at, updated_at)
         VALUES (@id, @kind, @title, @projectId, @cwd, @worktreePath, @branch, @baseBranch, @providerId, @modelId,
          @effort, @permissionMode, 'idle', @usage, @now, @now)`
      )
      .run({
        id,
        kind: input.kind,
        title: input.title,
        projectId: input.projectId,
        cwd: input.cwd,
        worktreePath: input.worktreePath,
        branch: input.branch,
        baseBranch: input.baseBranch,
        providerId: input.model?.providerId ?? null,
        modelId: input.model?.modelId ?? null,
        effort: input.effort,
        permissionMode: input.permissionMode,
        usage: JSON.stringify(EMPTY_SESSION_USAGE),
        now
      });
    this.indexTitle(id, input.title);
    return this.getSummary(id);
  }

  get(id: string): SessionSummary | null {
    const row = this.db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) as SessionRow | undefined;
    return row ? toSummary(row) : null;
  }

  getSummary(id: string): SessionSummary {
    const summary = this.get(id);
    if (!summary) throw new GraftError('session_not_found', `Session ${id} does not exist.`);
    return summary;
  }

  list(options: { kind?: SessionKind; includeArchived?: boolean } = {}): SessionSummary[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.kind) {
      where.push('s.kind = ?');
      params.push(options.kind);
    }
    if (!options.includeArchived) where.push('s.archived = 0');
    const sql = `${SESSION_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.pinned DESC, s.updated_at DESC`;
    return (this.db.prepare(sql).all(...params) as SessionRow[]).map(toSummary);
  }

  updateSession(id: string, patch: SessionPatch): SessionSummary {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    const set = (column: string, value: unknown): void => {
      sets.push(`${column} = @${column}`);
      params[column] = value;
    };
    if (patch.title !== undefined) set('title', patch.title);
    if (patch.status !== undefined) set('status', patch.status);
    if (patch.pinned !== undefined) set('pinned', patch.pinned ? 1 : 0);
    if (patch.archived !== undefined) set('archived', patch.archived ? 1 : 0);
    if (patch.unread !== undefined) set('unread', patch.unread ? 1 : 0);
    if (patch.lastError !== undefined) set('last_error', patch.lastError ? JSON.stringify(patch.lastError) : null);
    if (patch.usage !== undefined) set('usage', JSON.stringify(patch.usage));
    if (patch.todos !== undefined) set('todos', JSON.stringify(patch.todos));
    if (patch.model !== undefined) {
      set('provider_id', patch.model?.providerId ?? null);
      set('model_id', patch.model?.modelId ?? null);
    }
    if (patch.effort !== undefined) set('effort', patch.effort);
    if (patch.permissionMode !== undefined) set('permission_mode', patch.permissionMode);
    if (patch.cwd !== undefined) set('cwd', patch.cwd);
    if (patch.worktreePath !== undefined) set('worktree_path', patch.worktreePath);
    if (patch.branch !== undefined) set('branch', patch.branch);
    if (patch.baseBranch !== undefined) set('base_branch', patch.baseBranch);
    if (patch.projectId !== undefined) set('project_id', patch.projectId);
    if (sets.length === 0) return this.getSummary(id);
    // Status and read-state flips are not "activity"; they must not reorder the list.
    const touches = Object.keys(patch).some((k) => !['status', 'unread', 'pinned', 'usage', 'lastError'].includes(k));
    if (touches) set('updated_at', Date.now());
    const result = this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = @id`).run(params);
    if (result.changes === 0) throw new GraftError('session_not_found', `Session ${id} does not exist.`);
    if (patch.title !== undefined) this.indexTitle(id, patch.title);
    return this.getSummary(id);
  }

  touch(id: string): void {
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  getTodos(id: string): TodoItem[] {
    const row = this.db.prepare('SELECT todos FROM sessions WHERE id = ?').get(id) as { todos: string } | undefined;
    if (!row) throw new GraftError('session_not_found', `Session ${id} does not exist.`);
    return parseJson<TodoItem[]>(row.todos, 'todos');
  }

  delete(id: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM search_index WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    });
    tx();
  }

  appendMessage(sessionId: string, role: 'user' | 'assistant', content: ContentBlock[], meta: MessageMeta, id: string = randomUUID()): StoredMessage {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      const next = (
        this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE session_id = ?').get(sessionId) as {
          seq: number;
        }
      ).seq;
      this.db
        .prepare(
          'INSERT INTO messages (id, session_id, seq, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(id, sessionId, next, role, JSON.stringify(content), JSON.stringify(meta), now);
      this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
      const body = searchableText(content);
      if (body.length > 0) {
        this.db
          .prepare("INSERT INTO search_index (session_id, message_id, title, body) VALUES (?, ?, '', ?)")
          .run(sessionId, id, body.slice(0, SEARCH_BODY_LIMIT));
      }
      return next;
    });
    const seq = tx();
    return { id, sessionId, seq, role, content, meta, createdAt: now };
  }

  listMessages(sessionId: string): StoredMessage[] {
    return (
      this.db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC').all(sessionId) as MessageRow[]
    ).map(toMessage);
  }

  getMessage(messageId: string): StoredMessage | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as MessageRow | undefined;
    return row ? toMessage(row) : null;
  }

  updateMessageMeta(messageId: string, patch: Partial<MessageMeta>): StoredMessage {
    const current = this.getMessage(messageId);
    if (!current) throw new GraftError('message_not_found', `Message ${messageId} does not exist.`);
    const meta = { ...current.meta, ...patch };
    this.db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), messageId);
    return { ...current, meta };
  }

  markCompacted(sessionId: string, messageIds: string[], by?: string): void {
    const tx = this.db.transaction(() => {
      for (const id of messageIds) {
        const row = this.db.prepare('SELECT meta FROM messages WHERE id = ? AND session_id = ?').get(id, sessionId) as
          | { meta: string }
          | undefined;
        if (!row) continue;
        const meta: MessageMeta = { ...parseJson<MessageMeta>(row.meta, 'message meta'), compacted: true, ...(by ? { compactedBy: by } : {}) };
        this.db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), id);
      }
    });
    tx();
  }

  restoreCompacted(sessionId: string, by: string[]): number {
    if (by.length === 0) return 0;
    const gone = new Set(by);
    const tx = this.db.transaction(() => {
      // Only rows that name a replacement are read; a rewind is rare, so this need not be indexed.
      const rows = this.db.prepare("SELECT id, meta FROM messages WHERE session_id = ? AND meta LIKE '%\"compactedBy\"%'").all(sessionId) as Array<{
        id: string;
        meta: string;
      }>;
      let restored = 0;
      for (const row of rows) {
        const { compacted: _compacted, compactedBy, ...meta } = parseJson<MessageMeta>(row.meta, 'message meta');
        if (compactedBy === undefined || !gone.has(compactedBy)) continue;
        this.db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run(JSON.stringify(meta), row.id);
        restored++;
      }
      return restored;
    });
    return tx();
  }

  deleteMessagesFrom(sessionId: string, fromSeq: number): StoredMessage[] {
    const tx = this.db.transaction(() => {
      const rows = this.db
        .prepare('SELECT * FROM messages WHERE session_id = ? AND seq >= ? ORDER BY seq ASC')
        .all(sessionId, fromSeq) as MessageRow[];
      for (const row of rows) this.db.prepare('DELETE FROM search_index WHERE message_id = ?').run(row.id);
      this.db.prepare('DELETE FROM messages WHERE session_id = ? AND seq >= ?').run(sessionId, fromSeq);
      this.db.prepare('UPDATE sessions SET prune_before_seq = MIN(prune_before_seq, ?) WHERE id = ?').run(fromSeq, sessionId);
      return rows.map(toMessage);
    });
    return tx();
  }

  saveAgentRun(run: AgentRun): void {
    this.db
      .prepare(
        `INSERT INTO agent_runs (id, session_id, group_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
      )
      .run(run.id, run.sessionId, run.groupId, JSON.stringify(run), run.createdAt, Date.now());
  }

  listAgentRuns(sessionId: string): AgentRun[] {
    const rows = this.db.prepare('SELECT data FROM agent_runs WHERE session_id = ? ORDER BY created_at ASC, rowid ASC').all(sessionId) as Array<{ data: string }>;
    return rows.map((row) => storedAgentRun(row.data));
  }

  deleteAgentRunsFrom(sessionId: string, fromTime: number): void {
    this.db.prepare('DELETE FROM agent_runs WHERE session_id = ? AND created_at >= ?').run(sessionId, fromTime);
  }

  saveMission(mission: Mission): void {
    this.db
      .prepare(
        `INSERT INTO missions (id, session_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
      )
      .run(mission.id, mission.sessionId, JSON.stringify(mission), mission.createdAt, mission.updatedAt);
  }

  getMission(sessionId: string): Mission | null {
    const row = this.db.prepare('SELECT data FROM missions WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(sessionId) as { data: string } | undefined;
    return row ? parseJson<Mission>(row.data, 'mission') : null;
  }

  deleteMissionsFrom(sessionId: string, fromTime: number): void {
    this.db.prepare('DELETE FROM missions WHERE session_id = ? AND created_at >= ?').run(sessionId, fromTime);
  }

  recordUsage(entry: UsageEntry): void {
    this.db
      .prepare(
        `INSERT INTO usage_days (day, provider_id, model_id, requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, unpriced)
         VALUES (@day, @providerId, @modelId, 1, @input, @output, @cacheRead, @cacheWrite, @cost, @unpriced)
         ON CONFLICT(day, provider_id, model_id) DO UPDATE SET
           requests = requests + 1,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
           cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
           cost_usd = cost_usd + excluded.cost_usd,
           unpriced = unpriced + excluded.unpriced`
      )
      .run({
        day: entry.day,
        providerId: entry.providerId,
        modelId: entry.modelId,
        input: entry.usage.inputTokens,
        output: entry.usage.outputTokens,
        cacheRead: entry.usage.cacheReadTokens,
        cacheWrite: entry.usage.cacheWriteTokens,
        cost: entry.costUsd ?? 0,
        unpriced: entry.costUsd === null ? 1 : 0
      });
  }

  usageSince(fromDay: string): UsageDay[] {
    const rows = this.db.prepare('SELECT * FROM usage_days WHERE day >= ? ORDER BY day ASC, rowid ASC').all(fromDay) as Array<{
      day: string;
      provider_id: string;
      model_id: string;
      requests: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      cost_usd: number;
      unpriced: number;
    }>;
    return rows.map((row) => ({
      day: row.day,
      providerId: row.provider_id,
      modelId: row.model_id,
      requests: row.requests,
      usage: { inputTokens: row.input_tokens, outputTokens: row.output_tokens, cacheReadTokens: row.cache_read_tokens, cacheWriteTokens: row.cache_write_tokens },
      costUsd: row.cost_usd,
      unpriced: row.unpriced
    }));
  }

  /** Missions left going when the app last quit: they wait, paused, for the user to resume them. Returns how many. */
  recoverMissions(now: number = Date.now()): number {
    const rows = this.db.prepare('SELECT id, data FROM missions').all() as Array<{ id: string; data: string }>;
    let recovered = 0;
    for (const row of rows) {
      const mission = parseJson<Mission>(row.data, 'mission');
      const paused = recoverMission(mission, now);
      if (paused === mission) continue;
      this.db.prepare('UPDATE missions SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(paused), now, row.id);
      recovered++;
    }
    return recovered;
  }

  /** Agents left running when the app last quit: they stopped with it, and say so. Returns how many. */
  recoverAgentRuns(): number {
    const rows = this.db.prepare('SELECT id, data FROM agent_runs').all() as Array<{ id: string; data: string }>;
    let recovered = 0;
    for (const row of rows) {
      const run = storedAgentRun(row.data);
      if (!agentRunActive(run.status)) continue;
      const stopped: AgentRun = { ...run, status: 'cancelled', rev: run.rev + 1, error: 'Graft was closed while this agent was working.', endedAt: run.endedAt ?? Date.now(),
        ...(run.workspace?.state === 'working' ? { workspace: { ...run.workspace, state: 'retained' as const } } : {}) };
      this.db.prepare('UPDATE agent_runs SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(stopped), Date.now(), row.id);
      recovered++;
    }
    return recovered;
  }

  /** Full-text search over titles and message text (trigram: queries need ≥ 3 characters). */
  search(query: string, limit = 50): SearchHit[] {
    const trimmed = query.trim();
    if ([...trimmed].length < 3) return [];
    const rows = this.db
      .prepare(
        `SELECT session_id, message_id, snippet(search_index, -1, '', '', '…', 12) AS snippet
         FROM search_index WHERE search_index MATCH ? ORDER BY rank LIMIT ?`
      )
      .all(ftsPhrase(trimmed), limit * 4) as Array<{ session_id: string; message_id: string; snippet: string }>;
    const seen = new Set<string>();
    const hits: SearchHit[] = [];
    for (const row of rows) {
      if (seen.has(row.session_id)) continue;
      seen.add(row.session_id);
      hits.push({ sessionId: row.session_id, messageId: row.message_id === '' ? null : row.message_id, snippet: row.snippet });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  private indexTitle(sessionId: string, title: string): void {
    this.db.prepare("DELETE FROM search_index WHERE session_id = ? AND message_id = ''").run(sessionId);
    this.db
      .prepare("INSERT INTO search_index (session_id, message_id, title, body) VALUES (?, '', ?, '')")
      .run(sessionId, title);
  }
}

/** Text worth indexing: prose and tool-result text, not raw tool inputs or images. */
export function searchableText(content: ContentBlock[]): string {
  const parts: string[] = [];
  const direct = textOf(content);
  if (direct) parts.push(direct);
  for (const block of content) {
    if (block.type === 'tool_result') {
      for (const item of block.content) if (item.type === 'text') parts.push(item.text.slice(0, 2000));
    }
  }
  return parts.join('\n').trim();
}
