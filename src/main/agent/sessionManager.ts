import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { GraftError } from '@shared/errors';
import type { AgentEvent } from '@shared/schemas/agentEvents';
import type { EffortLevel, ModelRef, PermissionMode } from '@shared/schemas/common';
import { textOf, type FileAttachment, type ImageBlock, type StoredMessage } from '@shared/schemas/messages';
import type { PermissionResponse, QuestionResponse } from '@shared/schemas/permissions';
import type { RewindMode, RewindPreview, RewindResult } from '@shared/schemas/rewind';
import type { SessionDetail, SessionKind, SessionSummary } from '@shared/schemas/sessions';
import type { CreateSessionInput } from '@shared/ipc/contracts';
import { MemorySessionStore } from '../db/memorySessionStore';
import type { ProjectsRepo } from '../db/projectsRepo';
import { EMPTY_SESSION_USAGE, type SessionStore, type SessionsRepo } from '../db/sessionsRepo';
import type { CheckpointService } from '../git/checkpoints';
import { gitInfo } from '../git/repo';
import { createWorktree, removeWorktree, slugify } from '../git/worktrees';
import type { AppSettingsService } from '../settings/appSettings';
import type { SettingsStore } from '../permissions/settingsStore';
import type { ProviderRegistry } from '../providers/registry';
import type { ToolRegistry } from '../tools/registry';
import type { ShellSpec } from '../tools/shell/detect';
import type { ShellManager } from '../tools/shell/shellManager';
import type { GraftPaths } from '../app/paths';
import { HookRunner } from './hooks';
import { performRewind, previewRewind } from './rewind';
import { AgentSession, type SessionDeps } from './session';
import { generateTitle, titleModel } from './title';

export interface McpToolSource {
  toolNames(projectRoot: string | null): string[];
  serverNames(projectRoot: string | null): string[];
  /** Connects a trusted project's own servers (no-op for untrusted projects). */
  useProject(root: string, trusted: boolean): Promise<void>;
}

export interface SessionManagerDeps {
  repo: SessionsRepo;
  projects: ProjectsRepo;
  registry: ProviderRegistry;
  settings: AppSettingsService;
  settingsFiles: SettingsStore;
  tools: ToolRegistry;
  shells: ShellManager;
  shell: ShellSpec;
  checkpoints: CheckpointService;
  paths: GraftPaths;
  rgPath: string;
  mcp: McpToolSource | null;
  /** Session events and summary changes for the renderer. */
  emitEvent(sessionId: string, event: AgentEvent): void;
  emitSummary(summary: SessionSummary): void;
  emitRemoved(sessionId: string): void;
  /** Tools may have changed files in this folder (drops cached diff stats). */
  filesChanged(dir: string): void;
  /** Desktop notification; implementations decide based on window focus. */
  notify(summary: SessionSummary, kind: 'needs-input' | 'finished' | 'error', text: string, visible: boolean): void;
  log(level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, string | number | boolean>): void;
}

const SUMMARY_EVENTS = new Set<AgentEvent['type']>(['status', 'usage', 'mode', 'title', 'turn-end', 'turn-start', 'message']);

/** Owns every open session; each runs its own loop, so sessions run concurrently. */
export class SessionManager {
  private readonly live = new Map<string, AgentSession>();
  private readonly incognito = new MemorySessionStore();
  private activeId: string | null = null;
  private windowFocused = true;

  constructor(private readonly deps: SessionManagerDeps) {}

  /** Sessions left running or waiting when the app last quit are idle now. */
  recoverStaleStatuses(): void {
    for (const s of this.deps.repo.list({ includeArchived: true })) {
      if (s.status === 'running' || s.status === 'needs-input') this.deps.repo.updateSession(s.id, { status: 'idle' });
    }
  }

  setActive(id: string | null): void {
    this.activeId = id;
    if (id) this.markRead(id);
  }

  setWindowFocused(focused: boolean): void {
    this.windowFocused = focused;
  }

  private storeFor(id: string): SessionStore {
    return this.incognito.has(id) ? this.incognito : this.deps.repo;
  }

  private summaryOf(id: string): SessionSummary {
    const live = this.live.get(id);
    if (live) return live.liveSummary();
    return this.storeFor(id).getSummary(id);
  }

  /** Sessions with a turn in progress (for the tray tooltip). */
  runningCount(): number {
    let count = 0;
    for (const session of this.live.values()) if (session.liveSummary().status === 'running') count++;
    return count;
  }

  list(includeArchived: boolean): SessionSummary[] {
    const stored = this.deps.repo.list({ includeArchived });
    const merged = [...this.incognito.list(), ...stored].map((s) => {
      const live = this.live.get(s.id);
      return live ? live.liveSummary() : s;
    });
    return merged;
  }

  private sessionDeps(store: SessionStore): SessionDeps {
    const d = this.deps;
    return {
      store,
      models: {
        resolve: async (ref, signal) => ({ provider: d.registry.get(ref.providerId), model: await d.registry.resolveModel(ref, signal) })
      },
      tools: d.tools,
      mcpToolNames: (root) => d.mcp?.toolNames(root) ?? [],
      mcpServerNames: (root) => d.mcp?.serverNames(root) ?? [],
      shells: d.shells,
      shellLabel: d.shell.label,
      settings: d.settingsFiles,
      hooks: (root, trusted) => new HookRunner(() => d.settingsFiles.hooks(root, trusted), d.shell, () => root ?? process.cwd()),
      rgPath: d.rgPath,
      graftHome: d.paths.graftHome,
      platform: process.platform,
      isTrusted: (root) => d.projects.findByPath(root)?.trusted ?? false,
      trust: (root) => {
        const project = d.projects.findByPath(root) ?? d.projects.upsert(root);
        d.projects.update(project.id, { trusted: true });
      },
      preferences: () => {
        const s = d.settings.get();
        return {
          webSearch: s.behavior.webSearch,
          autoCompact: s.behavior.autoCompact,
          userName: s.profile.name || null,
          defaultModel: s.defaults.model,
          defaultEffort: s.defaults.effort
        };
      },
      gitInfo: async (cwd) => {
        const info = await gitInfo(cwd);
        return { isRepo: info.isRepo, branch: info.branch };
      },
      checkpoint: async (sessionId, cwd, messageId) => {
        if (store === this.incognito) return null;
        const record = await d.checkpoints.create(sessionId, cwd, messageId);
        return record.id;
      },
      emit: (sessionId, event) => this.onEvent(sessionId, event),
      notify: (summary, kind, text) => this.onNotify(summary, kind, text),
      generateTitle: (summary, text) => {
        this.title(summary, text).catch((error: unknown) => d.log('warn', 'Title generation failed', { message: (error as Error).message }));
      },
      log: (level, message, fields) => d.log(level, message, fields),
      now: () => new Date()
    };
  }

  private onEvent(sessionId: string, event: AgentEvent): void {
    const toolsRan = event.type === 'message' && event.message.role === 'user' && event.message.content.some((b) => b.type === 'tool_result');
    if (toolsRan || event.type === 'turn-end') {
      const summary = this.storeFor(sessionId).getSummary(sessionId);
      const dir = summary.worktreePath ?? summary.cwd;
      if (dir) this.deps.filesChanged(dir);
    }
    this.deps.emitEvent(sessionId, event);
    if (SUMMARY_EVENTS.has(event.type)) {
      try {
        this.deps.emitSummary(this.summaryOf(sessionId));
      } catch (error) {
        this.deps.log('warn', 'Could not refresh session summary', { message: (error as Error).message });
      }
    }
  }

  private onNotify(summary: SessionSummary, kind: 'needs-input' | 'finished' | 'error', text: string): void {
    const visible = this.windowFocused && this.activeId === summary.id;
    if (!visible && kind !== 'error') {
      this.storeFor(summary.id).updateSession(summary.id, { unread: true });
      this.deps.emitSummary(this.summaryOf(summary.id));
    }
    this.deps.notify(summary, kind, text, visible);
  }

  private async title(summary: SessionSummary, firstText: string): Promise<void> {
    const ref = summary.model ?? this.deps.settings.get().defaults.model;
    if (!ref) return;
    const models = await this.deps.registry.listModels(ref.providerId);
    const current = models.find((m) => m.ref.modelId === ref.modelId);
    if (!current) return;
    const chosen = titleModel(current, models);
    const title = await generateTitle(this.deps.registry.get(ref.providerId), chosen, firstText, AbortSignal.timeout(30_000));
    if (!title) return;
    const store = this.storeFor(summary.id);
    if (!['New session', 'New chat'].includes(store.getSummary(summary.id).title)) return;
    store.updateSession(summary.id, { title });
    this.onEvent(summary.id, { type: 'title', title });
  }

  get(id: string): AgentSession {
    const existing = this.live.get(id);
    if (existing) return existing;
    const store = this.storeFor(id);
    const summary = store.getSummary(id);
    const session = new AgentSession(summary, this.sessionDeps(store));
    this.live.set(id, session);
    const mcp = this.deps.mcp;
    if (mcp && summary.kind === 'code' && summary.projectPath) {
      const trusted = this.deps.projects.findByPath(summary.projectPath)?.trusted ?? false;
      mcp.useProject(summary.projectPath, trusted).catch((error: unknown) =>
        this.deps.log('warn', 'Could not start the project MCP servers', { message: (error as Error).message })
      );
    }
    return session;
  }

  detail(id: string): SessionDetail {
    return this.get(id).detail();
  }

  summary(id: string): SessionSummary {
    return this.summaryOf(id);
  }

  async create(input: CreateSessionInput): Promise<SessionSummary> {
    const settings = this.deps.settings.get();
    const kind: SessionKind = input.kind;
    const model: ModelRef | null = input.model ?? settings.defaults.model;
    const effort: EffortLevel | null = input.effort ?? settings.defaults.effort;
    let permissionMode: PermissionMode = input.permissionMode ?? settings.defaults.permissionMode;
    if (permissionMode === 'bypass' && !settings.behavior.bypassModeEnabled) permissionMode = 'ask';
    const title = kind === 'chat' ? 'New chat' : 'New session';

    if (input.incognito) {
      if (kind !== 'chat') throw new GraftError('incognito_chat_only', 'Only chats can be incognito.');
      const summary: SessionSummary = {
        id: randomUUID(),
        kind,
        title,
        status: 'idle',
        pinned: false,
        archived: false,
        unread: false,
        incognito: true,
        projectId: null,
        projectPath: null,
        projectName: null,
        cwd: null,
        worktreePath: null,
        branch: null,
        baseBranch: null,
        model,
        effort,
        permissionMode,
        lastError: null,
        usage: EMPTY_SESSION_USAGE,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      this.incognito.add(summary);
      return this.afterCreate(summary, input);
    }

    let projectId: string | null = null;
    let cwd: string | null = null;
    let worktreePath: string | null = null;
    let branch: string | null = null;
    let baseBranch: string | null = null;
    if (kind === 'code') {
      if (!input.projectPath) throw new GraftError('project_required', 'Choose a folder for this session.');
      if (!fs.existsSync(input.projectPath)) throw new GraftError('folder_missing', `The folder ${input.projectPath} doesn't exist.`);
      const project = this.deps.projects.upsert(input.projectPath);
      projectId = project.id;
      cwd = project.path;
      const info = await gitInfo(project.path);
      baseBranch = info.branch;
      branch = info.branch;
      if (input.useWorktree) {
        if (!info.isRepo) throw new GraftError('worktree_needs_git', 'Worktrees need a git repository. Turn off "worktree" for this folder.');
        const slug = slugify(input.message?.text.split('\n')[0] ?? '', 32);
        const created = await createWorktree({
          repoDir: project.path,
          worktreesRoot: this.deps.paths.worktrees,
          slug: slug === 'session' ? `session-${randomUUID().slice(0, 6)}` : slug,
          ...(input.branch ? { baseRef: input.branch } : {})
        });
        worktreePath = created.path;
        branch = created.branch;
        baseBranch = input.branch ?? info.branch;
      }
      this.deps.settings.update({ defaults: { lastProjectPath: project.path, useWorktree: input.useWorktree } });
    }
    const summary = this.deps.repo.create({
      kind,
      title,
      projectId,
      cwd,
      worktreePath,
      branch,
      baseBranch,
      model,
      effort,
      permissionMode
    });
    return this.afterCreate(summary, input);
  }

  private afterCreate(summary: SessionSummary, input: CreateSessionInput): SessionSummary {
    this.deps.emitSummary(summary);
    const m = input.message;
    if (m && (m.text.trim().length > 0 || m.images.length > 0 || m.files.length > 0)) {
      this.get(summary.id).send(m.text, m.images, m.files);
    }
    return this.summaryOf(summary.id);
  }

  send(id: string, text: string, images: ImageBlock[], files: FileAttachment[] = []): { queued: boolean } {
    return this.get(id).send(text, images, files);
  }

  interrupt(id: string): void {
    this.live.get(id)?.interrupt();
  }

  respondPermission(sessionId: string, response: PermissionResponse): void {
    this.get(sessionId).respondPermission(response);
  }

  answerQuestion(sessionId: string, response: QuestionResponse): void {
    this.get(sessionId).answerQuestion(response);
  }

  setMode(id: string, mode: PermissionMode): void {
    if (mode === 'bypass' && !this.deps.settings.get().behavior.bypassModeEnabled) {
      throw new GraftError('bypass_disabled', 'Bypass mode is turned off. Enable it in Settings → Permissions first.');
    }
    this.get(id).setPermissionMode(mode);
    this.deps.emitSummary(this.summaryOf(id));
  }

  /** Called when Bypass is turned off in Settings: every Bypass session drops to Ask. */
  demoteBypass(): void {
    for (const summary of this.list(true)) {
      if (summary.permissionMode !== 'bypass') continue;
      const live = this.live.get(summary.id);
      if (live) live.setPermissionMode('ask');
      else this.storeFor(summary.id).updateSession(summary.id, { permissionMode: 'ask' });
      this.deps.emitSummary(this.summaryOf(summary.id));
    }
  }

  cycleMode(id: string): PermissionMode {
    const mode = this.get(id).cyclePermissionMode();
    this.deps.emitSummary(this.summaryOf(id));
    return mode;
  }

  setModel(id: string, model: ModelRef, effort: EffortLevel | null): void {
    this.get(id).setModel(model, effort);
    this.deps.emitSummary(this.summaryOf(id));
  }

  private update(id: string, patch: Parameters<SessionStore['updateSession']>[1]): void {
    this.storeFor(id).updateSession(id, patch);
    this.deps.emitSummary(this.summaryOf(id));
  }

  rename(id: string, title: string): void {
    this.update(id, { title: title.trim() });
  }

  setPinned(id: string, pinned: boolean): void {
    this.update(id, { pinned });
  }

  markRead(id: string): void {
    if (this.storeFor(id).getSummary(id).unread) this.update(id, { unread: false });
  }

  async archive(id: string, archived: boolean, removeWorktreeToo: boolean, force: boolean): Promise<{ branchKeptReason: string | null }> {
    const summary = this.summaryOf(id);
    let branchKeptReason: string | null = null;
    if (archived) {
      const live = this.live.get(id);
      if (live?.isBusy) throw new GraftError('busy', 'Stop the session before archiving it.');
      if (removeWorktreeToo && summary.worktreePath && summary.projectPath) {
        const result = await removeWorktree({
          repoDir: summary.projectPath,
          worktreePath: summary.worktreePath,
          branch: summary.branch,
          force,
          deleteBranch: true
        });
        branchKeptReason = result.branchKeptReason;
        this.storeFor(id).updateSession(id, { worktreePath: null });
      }
      if (live) {
        await live.dispose();
        this.live.delete(id);
      }
    }
    this.update(id, { archived });
    return { branchKeptReason };
  }

  async remove(id: string, force: boolean): Promise<void> {
    const summary = this.summaryOf(id);
    const live = this.live.get(id);
    if (live) {
      await live.dispose();
      this.live.delete(id);
    }
    if (summary.worktreePath && summary.projectPath && fs.existsSync(summary.worktreePath)) {
      await removeWorktree({ repoDir: summary.projectPath, worktreePath: summary.worktreePath, branch: summary.branch, force, deleteBranch: true });
    }
    if (this.incognito.has(id)) {
      this.incognito.remove(id);
    } else {
      await this.deps.checkpoints.deleteForSession(id);
      this.deps.repo.delete(id);
    }
    this.deps.emitRemoved(id);
  }

  /**
   * Deletes every saved session (Settings → Data). Worktree folders stay on
   * disk so no uncommitted work is lost; their count is reported instead.
   */
  async clearHistory(): Promise<{ removed: number; worktreesKept: number }> {
    let removed = 0;
    let worktreesKept = 0;
    for (const summary of this.deps.repo.list({ includeArchived: true })) {
      const live = this.live.get(summary.id);
      if (live) {
        await live.dispose();
        this.live.delete(summary.id);
      }
      if (summary.worktreePath && fs.existsSync(summary.worktreePath)) worktreesKept++;
      await this.deps.checkpoints.deleteForSession(summary.id);
      this.deps.repo.delete(summary.id);
      this.deps.emitRemoved(summary.id);
      removed++;
    }
    return { removed, worktreesKept };
  }

  duplicate(id: string): SessionSummary {
    const source = this.summaryOf(id);
    if (source.incognito) throw new GraftError('incognito_duplicate', 'Incognito chats can\'t be duplicated.');
    const copy = this.deps.repo.create({
      kind: source.kind,
      title: `${source.title} (copy)`,
      projectId: source.projectId,
      cwd: source.cwd,
      worktreePath: null,
      branch: source.branch,
      baseBranch: source.baseBranch,
      model: source.model,
      effort: source.effort,
      permissionMode: source.permissionMode
    });
    for (const m of this.storeFor(id).listMessages(id)) this.deps.repo.appendMessage(copy.id, m.role, m.content, m.meta);
    this.deps.emitSummary(copy);
    return copy;
  }

  exportText(id: string, format: 'markdown' | 'json'): string {
    const summary = this.summaryOf(id);
    const messages = this.storeFor(id).listMessages(id);
    if (format === 'json') {
      return JSON.stringify({ exportedBy: 'Graft', exportedAt: new Date().toISOString(), session: summary, messages }, null, 2);
    }
    return renderMarkdown(summary, messages);
  }

  retry(id: string): void {
    this.get(id).retry();
  }

  regenerate(id: string): void {
    this.get(id).regenerate();
  }

  compact(id: string, instructions: string): void {
    this.get(id).compactNow(instructions);
  }

  removeQueued(id: string, queueId: string): void {
    this.get(id).removeQueued(queueId);
  }

  feedback(sessionId: string, messageId: string, value: -1 | 0 | 1): void {
    const store = this.storeFor(sessionId);
    const message = store.getMessage(messageId);
    if (!message || message.sessionId !== sessionId) throw new GraftError('message_not_found', 'That message no longer exists.');
    const updated = store.updateMessageMeta(messageId, { feedback: value });
    this.deps.emitEvent(sessionId, { type: 'message', message: updated });
  }

  private rewindDeps() {
    return {
      store: this.deps.repo,
      checkpoints: this.deps.checkpoints,
      truncate: (sessionId: string, seq: number) => {
        this.get(sessionId).truncateFrom(seq);
      }
    };
  }

  rewindPreview(sessionId: string, messageId: string): Promise<RewindPreview> {
    return previewRewind({ ...this.rewindDeps(), store: this.storeFor(sessionId) }, sessionId, messageId);
  }

  async rewind(sessionId: string, messageId: string, mode: RewindMode): Promise<RewindResult> {
    if (this.live.get(sessionId)?.isBusy) throw new GraftError('busy', 'Stop the session before rewinding it.');
    const result = await performRewind({ ...this.rewindDeps(), store: this.storeFor(sessionId) }, sessionId, messageId, mode);
    this.deps.emitSummary(this.summaryOf(sessionId));
    return result;
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.live.values()].map((s) => s.dispose()));
    this.live.clear();
  }
}

function renderMarkdown(summary: SessionSummary, messages: StoredMessage[]): string {
  const lines = [`# ${summary.title}`, '', `Exported from Graft on ${new Date().toISOString().slice(0, 10)}.`, ''];
  for (const m of messages) {
    if (m.meta.kind === 'notice') continue;
    const who = m.role === 'user' ? (m.meta.kind === 'compaction-summary' ? 'Summary' : 'You') : 'Graft';
    const parts: string[] = [];
    const text = textOf(m.content);
    if (text) parts.push(text);
    for (const b of m.content) {
      if (b.type === 'tool_use') parts.push(`> Used ${b.name}: \`${JSON.stringify(b.input).slice(0, 200)}\``);
      if (b.type === 'tool_result' && b.display?.kind === 'shell') parts.push(`> Exit code ${b.display.exitCode ?? '—'}`);
      if (b.type === 'image') parts.push('> [image]');
    }
    if (parts.length === 0) continue;
    const feedback = m.meta.feedback === 1 ? ' (marked helpful)' : m.meta.feedback === -1 ? ' (marked unhelpful)' : '';
    lines.push(`## ${who}${feedback}`, '', parts.join('\n\n'), '');
  }
  return lines.join('\n');
}
