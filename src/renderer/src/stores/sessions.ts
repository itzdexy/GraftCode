import { create } from 'zustand';
import type { AgentEvent } from '@shared/schemas/agentEvents';
import type { StoredMessage } from '@shared/schemas/messages';
import type { PermissionRequest, QuestionRequest } from '@shared/schemas/permissions';
import type { QueuedInput, SessionDetail, SessionSummary } from '@shared/schemas/sessions';
import type { TodoItem } from '@shared/schemas/toolDisplay';
import { errorText, invoke } from '../lib/ipc';

export interface Notice {
  id: number;
  level: 'info' | 'warning' | 'error';
  text: string;
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
  turnStartedAt: null
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

/**
 * The detail snapshot plus any messages that arrived by event after it was
 * taken (events and the reply travel separately, so either can come first).
 */
function mergeNewer(snapshot: StoredMessage[], local: StoredMessage[]): StoredMessage[] {
  const last = snapshot.reduce((max, m) => Math.max(max, m.seq), -1);
  const newer = local.filter((m) => m.seq > last);
  return newer.length === 0 ? snapshot : [...snapshot, ...newer].sort((a, b) => a.seq - b.seq);
}

function reduce(view: SessionView, event: AgentEvent): SessionView {
  switch (event.type) {
    case 'turn-start':
      return { ...view, turnActive: true, turnStartedAt: Date.now(), notices: [], retrying: null };
    case 'turn-end':
      return { ...view, turnActive: false, turnStartedAt: null, streaming: null, running: {}, retrying: null };
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
      return { ...view, messages: upsertMessage(view.messages, event.message), streaming, running };
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
      return { ...view, notices: [...view.notices, { id: ++noticeSeq, level: event.level, text: event.text }].slice(-6) };
    case 'retrying':
      return { ...view, retrying: { attempt: event.attempt, delayMs: event.delayMs, reason: event.reason } };
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

export const useSessions = create<SessionsState>((set, get) => ({
  summaries: {},
  loaded: false,
  views: {},
  viewOrder: [],

  async loadList() {
    const list = await invoke('sessions:list', { includeArchived: true });
    set({ summaries: Object.fromEntries(list.map((s) => [s.id, s])), loaded: true });
  },

  async open(id, options = {}) {
    const existing = options.reset ? undefined : get().views[id];
    const cached = evictViews({ ...get().views, [id]: { ...(existing ?? EMPTY_VIEW), loading: true, error: null } }, get().viewOrder, id);
    set({ views: cached.views, viewOrder: cached.order });
    try {
      const detail: SessionDetail = await invoke('sessions:get', { id });
      const current = get().views[id];
      // Evicted while loading (many sessions opened quickly): keep only the summary.
      if (!current) {
        set({ summaries: { ...get().summaries, [id]: detail.summary } });
        return;
      }
      set({
        summaries: { ...get().summaries, [id]: detail.summary },
        views: {
          ...get().views,
          [id]: {
            ...current,
            loading: false,
            messages: mergeNewer(detail.messages, current.messages),
            todos: detail.todos,
            queue: detail.queue,
            permission: detail.pendingPermission,
            question: detail.pendingQuestion,
            turnActive: detail.summary.status === 'running' || detail.summary.status === 'needs-input',
            turnStartedAt:
              detail.summary.status === 'running' || detail.summary.status === 'needs-input' ? (current.turnStartedAt ?? Date.now()) : null
          }
        }
      });
    } catch (error) {
      const current = get().views[id];
      if (current) set({ views: { ...get().views, [id]: { ...current, loading: false, error: errorText(error) } } });
    }
  },

  applySummary(summary) {
    set({ summaries: { ...get().summaries, [summary.id]: summary } });
  },

  applyEvent(sessionId, event) {
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
    const { [id]: _removed, ...summaries } = get().summaries;
    const { [id]: _view, ...views } = get().views;
    set({ summaries, views, viewOrder: get().viewOrder.filter((x) => x !== id) });
  },

  dismissNotice(sessionId, noticeId) {
    const view = get().views[sessionId];
    if (!view) return;
    set({ views: { ...get().views, [sessionId]: { ...view, notices: view.notices.filter((n) => n.id !== noticeId) } } });
  }
}));

export function viewOf(state: Pick<SessionsState, 'views'>, id: string): SessionView {
  return state.views[id] ?? EMPTY_VIEW;
}
