import { randomUUID } from 'node:crypto';
import { GraftError } from '@shared/errors';
import type { ContentBlock, MessageMeta, StoredMessage } from '@shared/schemas/messages';
import type { SessionSummary } from '@shared/schemas/sessions';
import type { TodoItem } from '@shared/schemas/toolDisplay';
import type { AgentRun } from '@shared/schemas/agentRuns';
import type { Mission } from '@shared/schemas/missions';
import type { SessionPatch, SessionStore } from './sessionsRepo';

/**
 * In-memory SessionStore: backs incognito chats (never written to disk) and
 * headless tests of the agent runtime.
 */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionSummary>();
  private readonly messages = new Map<string, StoredMessage[]>();
  private readonly todos = new Map<string, TodoItem[]>();
  private readonly agentRuns = new Map<string, AgentRun[]>();
  private readonly missions = new Map<string, Mission[]>();

  add(summary: SessionSummary): void {
    this.sessions.set(summary.id, summary);
    this.messages.set(summary.id, []);
    this.todos.set(summary.id, []);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.messages.delete(sessionId);
    this.todos.delete(sessionId);
    this.agentRuns.delete(sessionId);
    this.missions.delete(sessionId);
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()];
  }

  getSummary(sessionId: string): SessionSummary {
    const summary = this.sessions.get(sessionId);
    if (!summary) throw new GraftError('session_not_found', `Session ${sessionId} does not exist.`);
    return summary;
  }

  updateSession(sessionId: string, patch: SessionPatch): SessionSummary {
    const current = this.getSummary(sessionId);
    const { todos, ...rest } = patch;
    if (todos) this.todos.set(sessionId, todos);
    const next: SessionSummary = { ...current, ...rest, updatedAt: Date.now() };
    this.sessions.set(sessionId, next);
    return next;
  }

  getTodos(sessionId: string): TodoItem[] {
    this.getSummary(sessionId);
    return this.todos.get(sessionId) ?? [];
  }

  appendMessage(sessionId: string, role: 'user' | 'assistant', content: ContentBlock[], meta: MessageMeta, id: string = randomUUID()): StoredMessage {
    const list = this.list_(sessionId);
    const message: StoredMessage = {
      id,
      sessionId,
      seq: (list.at(-1)?.seq ?? 0) + 1,
      role,
      content,
      meta,
      createdAt: Date.now()
    };
    list.push(message);
    return message;
  }

  listMessages(sessionId: string): StoredMessage[] {
    return [...this.list_(sessionId)];
  }

  getMessage(messageId: string): StoredMessage | null {
    for (const list of this.messages.values()) {
      const found = list.find((m) => m.id === messageId);
      if (found) return found;
    }
    return null;
  }

  updateMessageMeta(messageId: string, patch: Partial<MessageMeta>): StoredMessage {
    for (const list of this.messages.values()) {
      const index = list.findIndex((m) => m.id === messageId);
      const found = list[index];
      if (found) {
        const next = { ...found, meta: { ...found.meta, ...patch } };
        list[index] = next;
        return next;
      }
    }
    throw new GraftError('message_not_found', `Message ${messageId} does not exist.`);
  }

  markCompacted(sessionId: string, messageIds: string[]): void {
    const ids = new Set(messageIds);
    const list = this.list_(sessionId);
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m && ids.has(m.id)) list[i] = { ...m, meta: { ...m.meta, compacted: true } };
    }
  }

  deleteMessagesFrom(sessionId: string, fromSeq: number): StoredMessage[] {
    const list = this.list_(sessionId);
    const kept = list.filter((m) => m.seq < fromSeq);
    const removed = list.filter((m) => m.seq >= fromSeq);
    this.messages.set(sessionId, kept);
    return removed;
  }

  saveAgentRun(run: AgentRun): void {
    const runs = this.agentRuns.get(run.sessionId) ?? [];
    const index = runs.findIndex((r) => r.id === run.id);
    if (index === -1) runs.push(run);
    else runs[index] = run;
    this.agentRuns.set(run.sessionId, runs);
  }

  listAgentRuns(sessionId: string): AgentRun[] {
    return [...(this.agentRuns.get(sessionId) ?? [])];
  }

  deleteAgentRunsFrom(sessionId: string, fromTime: number): void {
    this.agentRuns.set(sessionId, (this.agentRuns.get(sessionId) ?? []).filter((r) => r.createdAt < fromTime));
  }

  saveMission(mission: Mission): void {
    const list = this.missions.get(mission.sessionId) ?? [];
    const index = list.findIndex((m) => m.id === mission.id);
    if (index === -1) list.push(mission);
    else list[index] = mission;
    this.missions.set(mission.sessionId, list);
  }

  getMission(sessionId: string): Mission | null {
    return this.missions.get(sessionId)?.at(-1) ?? null;
  }

  deleteMissionsFrom(sessionId: string, fromTime: number): void {
    this.missions.set(sessionId, (this.missions.get(sessionId) ?? []).filter((m) => m.createdAt < fromTime));
  }

  private list_(sessionId: string): StoredMessage[] {
    const list = this.messages.get(sessionId);
    if (!list) throw new GraftError('session_not_found', `Session ${sessionId} does not exist.`);
    return list;
  }
}
