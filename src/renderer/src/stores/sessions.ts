import { create } from 'zustand';
import type { AgentEvent } from '@shared/schemas/agentEvents';
import type { AgentRun } from '@shared/schemas/agentRuns';
import type { StoredMessage } from '@shared/schemas/messages';
import type { Mission } from '@shared/schemas/missions';
import type { PermissionRequest, QuestionRequest } from '@shared/schemas/permissions';
import type { QueuedInput, SessionDetail, SessionSummary } from '@shared/schemas/sessions';
import type { TodoItem } from '@shared/schemas/toolDisplay';
import { errorText, invoke } from '../lib/ipc';
import { createDeltaBuffer } from './deltaBuffer';

export interface Notice {
  id: number;
  level: 'info' | 'warning' | 'error';
  text: string;
  /** "continue": the turn paused at the step limit and can pick up where it stopped. */
  action?: 'continue';
}

export interface SessionView {
  loading: boolean;
  error: string | null;
  messages: StoredMessage[];
  todos: TodoItem[];
  queue: QueuedInput[];
  permission: PermissionRequest | null;
  question: QuestionRequest | null;
  /** The assistant reply currently streaming, before it is stored. */
  streaming: { messageId: string; text: string; thinking: string } | null;
  /** Tools running now, keyed by tool_use id. */
  running: Record<string, { name: string; summary: string; output: string }>;
  notices: Notice[];
  retrying: { attempt: number; delayMs: number; reason: string } | null;
  turnActive: boolean;
  /** When the running turn started (for the elapsed time next to the thinking indicator). */
  turnStartedAt: number | null;
  /** The "!" command running now, when the active "turn" is one (no model is working). */
  shellCommand: string | null;
  /** The project's checks running now, after the turn changed files. */
  checking: { commands: string[]; round: number; startedAt: number } | null;
  /** The agents of every group this session ran (RunAgents), oldest first: the Agents panel draws them. */
  agentRuns: AgentRun[];
  /** The session's newest mission, whatever its state; null when it has none. */
  mission: Mission | null;
}

const EMPTY_VIEW: SessionView = {
  loading: false,
  error: null,
  messages: [],
  todos: [],
  queue: [],
  permission: null,
  question: null,
  streaming: null,
  running: {},
  notices: [],
  retrying: null,
  turnActive: false,
  turnStartedAt: null,
  shellCommand: null,
  checking: null,
  agentRuns: [],
  mission: null
};

let noticeSeq = 0;
const MAX_TOOL_OUTPUT = 20_000;
/** Transcripts kept in memory; older ones are dropped and reloaded from main when reopened. */
export const MAX_CACHED_VIEWS = 8;

/** Keeps the most recently opened views (the one just opened last). */
export function evictViews(views: Record<string, SessionView>, order: string[], opened: string): { views: Record<string, SessionView>; order: string[] } {
  const nextOrder = [...order.filter((id) => id !== opened && id in views), opened];
  if (nextOrder.length <= MAX_CACHED_VIEWS) return { views, order: nextOrder };
  const dropped = new Set(nextOrder.slice(0, nextOrder.length - MAX_CACHED_VIEWS));
  return { views: Object.fromEntries(Object.entries(views).filter(([id]) => !dropped.has(id))), order: nextOrder.filter((id) => !dropped.has(id)) };
}

interface SessionsState {
  summaries: Record<string, SessionSummary>;
  loaded: boolean;
  /** Why the session list could not be loaded, so the view can offer a retry. */
  loadError: string | null;
  views: Record<string, SessionView>;
  /** Opened session ids, least recent first (for evicting cached views). */
  viewOrder: string[];
  loadList: () => Promise<void>;
  /** Loads a session's detail. `reset` discards the local view first (after a rewind removed messages). */
  open: (id: string, options?: { reset?: boolean }) => Promise<void>;
  applySummary: (summary: SessionSummary) => void;
  applyEvent: (sessionId: string, event: AgentEvent) => void;
  remove: (id: string) => void;
  dismissNotice: (sessionId: string, noticeId: number) => void;
}

function upsertMessage(messages: StoredMessage[], message: StoredMessage): StoredMessage[] {
  const index = messages.findIndex((m) => m.id === message.id);
  if (index === -1) return [...messages, message].sort((a, b) => a.seq - b.seq);
  const next = [...messages];
  next[index] = message;
  return next;
}

/** An agent's record takes the place of an earlier one; an older record arriving late changes nothing. */
function upsertAgentRun(runs: AgentRun[], run: AgentRun): AgentRun[] {
  const index = runs.findIndex((r) => r.id === run.id);
  if (index === -1) return [...runs, run];
  if ((runs[index]?.rev ?? -1) >= run.rev) return runs;
  const next = [...runs];
  next[index] = run;
  return next;
}

/** The loaded agents plus what was heard by event while they loaded: for each agent, the later record. */
export function mergeAgentRuns(snapshot: AgentRun[], local: AgentRun[]): AgentRun[] {
  return local.length === 0 ? snapshot : local.reduce(upsertAgentRun, snapshot);
}

function reduce(view: SessionView, event: AgentEvent): SessionView {
  switch (event.type) {
    case 'turn-start':
      return { ...view, turnActive: true, turnStartedAt: Date.now(), notices: [], retrying: null, shellCommand: event.shell ?? null, checking: null };
    case 'turn-end':
      return { ...view, turnActive: false, turnStartedAt: null, streaming: null, running: {}, retrying: null, shellCommand: null, checking: null };
    case 'checks':
      return { ...view, checking: { commands: event.commands, round: event.round, startedAt: Date.now() } };
    case 'assistant-start':
      return { ...view, streaming: { messageId: event.messageId, text: '', thinking: '' }, retrying: null };
    case 'assistant-delta': {
      const current = view.streaming && view.streaming.messageId === event.messageId ? view.streaming : { messageId: event.messageId, text: '', thinking: '' };
      return {
        ...view,
        streaming:
          event.kind === 'text' ? { ...current, text: current.text + event.text } : { ...current, thinking: current.thinking + event.text }
      };
    }
    case 'message': {
      const streaming = view.streaming?.messageId === event.message.id ? null : view.streaming;
      let running = view.running;
      if (event.message.role === 'user') {
        const done = event.message.content.filter((b) => b.type === 'tool_result').map((b) => (b.type === 'tool_result' ? b.toolUseId : ''));
        if (done.length > 0) {
          running = { ...running };
          for (const id of done) delete running[id];
        }
      }
      const checking = event.message.meta.kind === 'check' ? null : view.checking;
      return { ...view, messages: upsertMessage(view.messages, event.message), streaming, running, checking };
    }
    case 'tool-start':
      return { ...view, running: { ...view.running, [event.toolUseId]: { name: event.name, summary: event.summary, output: '' } } };
    case 'tool-progress': {
      const tool = view.running[event.toolUseId];
      if (!tool) return view;
      const output = (tool.output + event.chunk).slice(-MAX_TOOL_OUTPUT);
      return { ...view, running: { ...view.running, [event.toolUseId]: { ...tool, output } } };
    }
    case 'permission':
      return { ...view, permission: event.request };
    case 'permission-resolved':
      return view.permission?.id === event.requestId ? { ...view, permission: null } : view;
    case 'question':
      return { ...view, question: event.request };
    case 'question-resolved':
      return view.question?.id === event.requestId ? { ...view, question: null } : view;
    case 'todos':
      return { ...view, todos: event.todos };
    case 'queue':
      return { ...view, queue: event.queue };
    case 'notice':
      return { ...view, notices: [...view.notices, { id: ++noticeSeq, level: event.level, text: event.text, ...(event.action ? { action: event.action } : {}) }].slice(-6) };
    case 'retrying':
      return { ...view, retrying: { attempt: event.attempt, delayMs: event.delayMs, reason: event.reason } };
    case 'agent-run': {
      const agentRuns = upsertAgentRun(view.agentRuns, event.run);
      return agentRuns === view.agentRuns ? view : { ...view, agentRuns };
    }
    case 'mission':
      // An older state of the same mission arriving late changes nothing.
      if (event.mission && view.mission && event.mission.id === view.mission.id && event.mission.rev <= view.mission.rev) return view;
      return { ...view, mission: event.mission };
    case 'compacted':
    case 'status':
    case 'usage':
    case 'mode':
    case 'title':
      return view;
  }
}

function applyToSummary(summary: SessionSummary | undefined, event: AgentEvent): SessionSummary | undefined {
  if (!summary) return summary;
  switch (event.type) {
    case 'status':
      return { ...summary, status: event.status, lastError: event.error };
    case 'usage':
      return { ...summary, usage: event.usage };
    case 'mode':
      return { ...summary, permissionMode: event.permissionMode };
    case 'title':
      return { ...summary, title: event.title };
    default:
      return summary;
  }
}

type LoadUpdate = AgentEvent | { type: 'summary'; summary: SessionSummary };
const DETAIL_EVENTS = new Set<AgentEvent['type']>([
  'message', 'todos', 'queue', 'permission', 'permission-resolved', 'question', 'question-resolved',
  'agent-run', 'mission', 'status', 'usage', 'mode', 'title', 'turn-start', 'turn-end'
]);
const MAX_PENDING_UPDATES = 512;

export const useSessions = create<SessionsState>((set, get) => {
  // Only the newest request owns a view. Cached records from before that request
  // are not an overlay: main may have deleted them in a rewind.
  const loads = new Map<string, { updates: Map<string, LoadUpdate> }>();
  const remember = (id: string, update: LoadUpdate): void => {
    const load = loads.get(id);
    if (!load) return;
    const key = update.type === 'message' ? `message:${update.message.id}`
      : update.type === 'agent-run' ? `agent-run:${update.run.id}`
        : update.type === 'permission-resolved' || update.type === 'question-resolved' ? `${update.type}:${update.requestId}`
          : update.type === 'turn-start' || update.type === 'turn-end' ? 'turn' : update.type;
    const previous = load.updates.get(key);
    if (update.type === 'agent-run' && previous?.type === 'agent-run' && previous.run.rev >= update.run.rev) return;
    if (update.type === 'mission' && previous?.type === 'mission' && previous.mission && update.mission &&
        previous.mission.id === update.mission.id && previous.mission.rev >= update.mission.rev) return;
    // Keep the latest value in event order, without buffering streaming deltas.
    load.updates.delete(key);
    load.updates.set(key, update);
    if (load.updates.size <= MAX_PENDING_UPDATES) return;
    loads.delete(id);
    const current = get().views[id];
    if (current) set({ views: { ...get().views, [id]: { ...current, loading: false, error: 'The session changed too much while loading. Reopen it to refresh.' } } });
  };
  return {
  summaries: {},
  loaded: false,
  loadError: null,
  views: {},
  viewOrder: [],

  // Records the failure instead of throwing: a rejected list left `loaded` false for
  // good, which blanked the session view and the sidebar for the rest of the run.
  async loadList() {
    try {
      const list = await invoke('sessions:list', { includeArchived: true });
      set({ summaries: Object.fromEntries(list.map((s) => [s.id, s])), loaded: true, loadError: null });
    } catch (error) {
      set({ loadError: errorText(error) });
    }
  },

  async open(id, options = {}) {
    deltas.flush(id);
    const load = { updates: new Map<string, LoadUpdate>() };
    loads.set(id, load);
    const existing = options.reset ? undefined : get().views[id];
    const cached = evictViews({ ...get().views, [id]: { ...(existing ?? EMPTY_VIEW), loading: true, error: null } }, get().viewOrder, id);
    set({ views: cached.views, viewOrder: cached.order });
    for (const loadingId of loads.keys()) if (!(loadingId in cached.views)) loads.delete(loadingId);
    try {
      const detail: SessionDetail = await invoke('sessions:get', { id });
      if (loads.get(id) !== load) return;
      const current = get().views[id];
      if (!current) return;
      let summary = detail.summary;
      let snapshot: SessionView = {
        ...EMPTY_VIEW, messages: detail.messages, todos: detail.todos, queue: detail.queue,
        agentRuns: detail.agentRuns, mission: detail.mission,
        permission: detail.pendingPermission, question: detail.pendingQuestion
      };
      for (const update of load.updates.values()) {
        if (update.type === 'summary') summary = update.summary;
        else {
          snapshot = reduce(snapshot, update);
          summary = applyToSummary(summary, update) ?? summary;
        }
      }
      const active = load.updates.has('turn') ? current.turnActive : summary.status === 'running' || summary.status === 'needs-input';
      set({
        summaries: { ...get().summaries, [id]: summary },
        views: {
          ...get().views,
          [id]: {
            ...current,
            loading: false,
            messages: snapshot.messages,
            todos: snapshot.todos,
            queue: snapshot.queue,
            agentRuns: snapshot.agentRuns,
            mission: snapshot.mission,
            permission: snapshot.permission,
            question: snapshot.question,
            turnActive: active,
            turnStartedAt: active ? (current.turnStartedAt ?? Date.now()) : null
          }
        }
      });
    } catch (error) {
      if (loads.get(id) !== load) return;
      const current = get().views[id];
      if (current) set({ views: { ...get().views, [id]: { ...current, loading: false, error: errorText(error) } } });
    } finally {
      if (loads.get(id) === load) loads.delete(id);
    }
  },

  applySummary(summary) {
    remember(summary.id, { type: 'summary', summary });
    set({ summaries: { ...get().summaries, [summary.id]: summary } });
  },

  applyEvent(sessionId, event) {
    // Streamed text waits for the next frame (deltaBuffer); everything else applies now, after any text still waiting.
    if (event.type === 'assistant-delta') {
      deltas.push(sessionId, event);
      return;
    }
    deltas.flush(sessionId);
    // Resolutions must be remembered even when the initial view has not loaded
    // its prompt yet. The overlay separately keeps the greatest record revision.
    if (DETAIL_EVENTS.has(event.type)) remember(sessionId, event);
    const views = get().views;
    const view = views[sessionId];
    const summaries = get().summaries;
    const nextSummary = applyToSummary(summaries[sessionId], event);
    set({
      views: view ? { ...views, [sessionId]: reduce(view, event) } : views,
      summaries: nextSummary && nextSummary !== summaries[sessionId] ? { ...summaries, [sessionId]: nextSummary } : summaries
    });
  },

  remove(id) {
    deltas.flush(id);
    loads.delete(id);
    const { [id]: _removed, ...summaries } = get().summaries;
    const { [id]: _view, ...views } = get().views;
    set({ summaries, views, viewOrder: get().viewOrder.filter((x) => x !== id) });
  },

  dismissNotice(sessionId, noticeId) {
    const view = get().views[sessionId];
    if (!view) return;
    set({ views: { ...get().views, [sessionId]: { ...view, notices: view.notices.filter((n) => n.id !== noticeId) } } });
  }
  };
});

/** Streamed text for all sessions, applied once a frame. Without frames (unit tests) it applies at once. */
const deltas = createDeltaBuffer(
  (sessionId, pieces) => {
    const views = useSessions.getState().views;
    const view = views[sessionId];
    if (view) useSessions.setState({ views: { ...views, [sessionId]: pieces.reduce(reduce, view) } });
  },
  (run) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else run();
  }
);

export function viewOf(state: Pick<SessionsState, 'views'>, id: string): SessionView {
  return state.views[id] ?? EMPTY_VIEW;
}
