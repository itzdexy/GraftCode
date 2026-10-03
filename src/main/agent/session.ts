import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '@shared/schemas/agentEvents';
import { addUsage, EFFORT_LEVELS, type EffortLevel, type ModelRef, type PermissionMode, type Usage } from '@shared/schemas/common';
import { type ContentBlock, type FileAttachment, type ImageBlock, type LlmMessage, type MessageMeta, type StoredMessage } from '@shared/schemas/messages';
import type { ModelInfo } from '@shared/schemas/models';
import type { PermissionRequest, PermissionResponse, QuestionAnswer, QuestionRequest, QuestionResponse } from '@shared/schemas/permissions';
import type { QueuedInput, SessionDetail, SessionStatus, SessionSummary } from '@shared/schemas/sessions';
import type { TodoItem } from '@shared/schemas/toolDisplay';
import { GraftError } from '@shared/errors';
import type { DataHandling } from '@shared/privacy';
import type { SearchEngineId, SearchResult } from '../tools/web/search';
import type { ComputerControl } from '../computer/desktop';
import type { SessionPatch, SessionStore } from '../db/sessionsRepo';
import type { RetryPolicy } from '../providers/retry';
import type { LLMProvider, RequestPrivacy } from '../providers/types';
import { decide, type Decision } from '../permissions/engine';
import type { SettingsStore } from '../permissions/settingsStore';
import { FileStateTracker } from '../tools/fileState';
import type { ToolRegistry } from '../tools/registry';
import type { ShellManager } from '../tools/shell/shellManager';
import type { SubagentType, ToolContext } from '../tools/types';
import { CHAT_ONLY_TOOLS, PARENT_ONLY_TOOLS, READ_ONLY_TOOLS } from '../tools/builtin';
import type { ChatFile } from '../chat/chatFiles';
import type { CodeRun } from '../chat/codeSandbox';
import { summarizeSession, summaryMessageText } from './compaction';
import type { HookRunner } from './hooks';
import { toLlmHistory, withSentTimes } from './history';
import { runAgentLoop, type LoopHost, type PermissionAnswer, type PermissionPrompt } from './loop';
import { expandMentions } from './mentions';
import { MemoryLoader } from './memory';
import { loadSkills } from './skills';
import {
  commitPrompt,
  expandCommand,
  explainPrompt,
  INIT_PROMPT,
  listCommands,
  loadCustomCommands,
  parseSlash,
  prPrompt,
  PROMPT_COMMANDS,
  reviewPrompt,
  securityReviewPrompt,
  testPrompt,
  UI_COMMANDS
} from './slashCommands';
import { buildChatSystemPrompt, buildCodeSystemPrompt, modeChangeNote, TAPROOT_MARKER, TAPROOT_NOTE, type Personalization } from './systemPrompt';
import { cleanTitle } from './title';
import { shouldCompact } from './tokens';

export interface ModelResolver {
  resolve(ref: ModelRef, signal?: AbortSignal): Promise<{ provider: LLMProvider; model: ModelInfo }>;
}

export interface SessionPreferences {
  webSearch: boolean;
  /** Bypass is switched on in Settings: it joins the Shift+Tab cycle and /permissions. */
  bypassEnabled: boolean;
  /** See PermissionEnv.bypassKeepsChecks. */
  bypassKeepsChecks: boolean;
  autoCompact: boolean;
  userName: string | null;
  defaultModel: ModelRef | null;
  defaultEffort: EffortLevel;
  /** Ask providers not to train on or keep requests (Settings → Privacy). */
  noTraining: boolean;
  /** Incognito chats may only use models served from this computer. */
  incognitoLocalOnly: boolean;
  /** Settings → Permissions: code sessions may use the screen, mouse and keyboard. */
  computerUse: boolean;
  /** Settings → Personalization, added to system prompts (never to incognito chats). */
  personalization: Personalization;
}

export interface SessionDeps {
  store: SessionStore;
  /** Backoff policy for provider retries (tests shorten it). */
  retryPolicy?: RetryPolicy;
  models: ModelResolver;
  tools: ToolRegistry;
  /** MCP tools/servers visible to a session in this project (user servers plus the project's own). */
  mcpToolNames(projectRoot: string | null): string[];
  mcpServerNames(projectRoot: string | null): string[];
  shells: ShellManager;
  shellLabel: string;
  settings: SettingsStore;
  hooks(projectRoot: string | null, trusted: boolean): HookRunner | null;
  rgPath: string;
  graftHome: string;
  platform: NodeJS.Platform;
  isTrusted(projectRoot: string): boolean;
  trust(projectRoot: string): void;
  preferences(): SessionPreferences;
  /** Display name of the provider behind a provider id, e.g. "OpenRouter". */
  providerName(providerId: string): string;
  /** How the provider behind a provider id treats what it receives. */
  dataHandling(providerId: string): DataHandling;
  /** Screen, mouse and keyboard (Windows); null where computer use isn't available. */
  computer: ComputerControl | null;
  /** Web search for the WebSearch tool (Settings → Web search). */
  search: {
    active(): SearchEngineId | null;
    search(query: string, count: number, signal: AbortSignal): Promise<{ engine: SearchEngineId; results: SearchResult[] }>;
  };
  /** Files chats make for the user to download (CreateFile, RunCode); null where unavailable. */
  chatFiles: { save(sessionId: string, name: string, data: Buffer): ChatFile } | null;
  /** RunCode's sandbox: JavaScript in an isolated page; null where unavailable. */
  runCode: ((code: string, timeoutMs: number, signal: AbortSignal) => Promise<CodeRun>) | null;
  gitInfo(cwd: string): Promise<{ isRepo: boolean; branch: string | null }>;
  /** Snapshots the working tree before a user turn; returns a checkpoint id, or null when unavailable. */
  checkpoint(sessionId: string, cwd: string, messageId: string): Promise<string | null>;
  emit(sessionId: string, event: AgentEvent): void;
  notify(summary: SessionSummary, kind: 'needs-input' | 'finished' | 'error', text: string): void;
  generateTitle(summary: SessionSummary, firstText: string): void;
  log(level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, string | number | boolean>): void;
  now(): Date;
}

interface InternalQueued {
  id: string;
  text: string;
  images: ImageBlock[];
  files: FileAttachment[];
  createdAt: number;
}

const MAX_ITERATIONS = 150;
const TAPROOT_ITERATIONS = 500;
const SUBAGENT_ITERATIONS = 80;
const DELTA_FLUSH_MS = 40;
/** "!" commands from the message box: how long they may run, and how much of their output the transcript keeps. */
const USER_SHELL_TIMEOUT_MS = 300_000;
const USER_SHELL_SHOWN = 20_000;
const MODE_CYCLE: PermissionMode[] = ['ask', 'auto-edit', 'plan', 'auto'];
const DEFAULT_TITLES = new Set(['New session', 'New chat']);

/**
 * One conversation and its agent runtime. Turns run one at a time; input
 * sent while a turn runs is queued. Concurrency across sessions comes from
 * each session having its own loop, abort controller and state.
 */
export class AgentSession {
  readonly id: string;
  private status: SessionStatus = 'idle';
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;
  private queue: InternalQueued[] = [];
  private pendingPermission: { request: PermissionRequest; resolve: (a: PermissionAnswer) => void } | null = null;
  private pendingQuestion: { request: QuestionRequest; resolve: (a: QuestionAnswer[] | null) => void } | null = null;
  private readonly sessionAllow: string[] = [];
  readonly files: FileStateTracker;
  private memory: MemoryLoader | null = null;
  private system: string | null = null;
  private toolNames: string[] | null = null;
  private promptKey: string | null = null;
  private modelKey: string | null = null;
  /** Thinking in messages before this seq is never replayed (model switch, tool set change). */
  private stripBeforeSeq = 0;
  private notes: string[] = [];
  private prePlanMode: PermissionMode = 'auto-edit';
  private deltaBuffer: { messageId: string; kind: 'text' | 'thinking'; text: string } | null = null;
  private deltaTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    summary: SessionSummary,
    private readonly deps: SessionDeps
  ) {
    this.id = summary.id;
    this.files = new FileStateTracker(deps.platform);
    this.status = summary.status === 'running' || summary.status === 'needs-input' ? 'idle' : summary.status;
  }

  get summary(): SessionSummary {
    return this.deps.store.getSummary(this.id);
  }

  get isBusy(): boolean {
    return this.running !== null;
  }

  /** Stored summary with the live status (cheap: no message loading). */
  liveSummary(): SessionSummary {
    return { ...this.summary, status: this.status };
  }

  detail(): SessionDetail {
    return {
      summary: this.liveSummary(),
      messages: this.deps.store.listMessages(this.id),
      todos: this.deps.store.getTodos(this.id),
      pendingPermission: this.pendingPermission?.request ?? null,
      pendingQuestion: this.pendingQuestion?.request ?? null,
      queue: this.publicQueue()
    };
  }

  private publicQueue(): QueuedInput[] {
    return this.queue.map((q) => ({ id: q.id, text: q.text, attachmentCount: q.images.length + q.files.length, createdAt: q.createdAt }));
  }

  // ---- events -------------------------------------------------------------

  private flushDeltas(): void {
    if (this.deltaTimer) clearTimeout(this.deltaTimer);
    this.deltaTimer = null;
    const buffered = this.deltaBuffer;
    this.deltaBuffer = null;
    if (buffered && buffered.text.length > 0) this.deps.emit(this.id, { type: 'assistant-delta', ...buffered });
  }

  /** Coalesces streaming deltas (~25 per second) while keeping event order intact. */
  private emit(event: AgentEvent): void {
    if (this.disposed) return;
    if (event.type === 'assistant-delta') {
      const b = this.deltaBuffer;
      if (b && b.messageId === event.messageId && b.kind === event.kind) {
        b.text += event.text;
      } else {
        this.flushDeltas();
        this.deltaBuffer = { messageId: event.messageId, kind: event.kind, text: event.text };
      }
      this.deltaTimer ??= setTimeout(() => this.flushDeltas(), DELTA_FLUSH_MS);
      return;
    }
    this.flushDeltas();
    this.deps.emit(this.id, event);
  }

  private setStatus(status: SessionStatus, error: { code: string; message: string } | null = null): void {
    this.status = status;
    const patch: SessionPatch = { status };
    if (status === 'error') patch.lastError = error;
    if (status === 'idle' || status === 'running') patch.lastError = null;
    this.deps.store.updateSession(this.id, patch);
    this.emit({ type: 'status', status, error });
  }

  private notice(level: 'info' | 'warning' | 'error', text: string): void {
    this.emit({ type: 'notice', level, text });
  }

  /** A message shown in the transcript but never sent to the model. */
  private commandOutput(text: string): void {
    const stored = this.deps.store.appendMessage(this.id, 'assistant', [{ type: 'text', text }], { kind: 'command-output' });
    this.emit({ type: 'message', message: stored });
  }

  // ---- public controls ----------------------------------------------------

  /** Sends user input, or queues it while a turn is running. */
  send(text: string, images: ImageBlock[] = [], files: FileAttachment[] = []): { queued: boolean } {
    if (this.disposed) throw new GraftError('session_closed', 'This session is closed.');
    const trimmed = text.trim();
    if (trimmed.length === 0 && images.length === 0 && files.length === 0) throw new GraftError('empty_message', 'Type a message first.');
    const item: InternalQueued = { id: randomUUID(), text: trimmed, images, files, createdAt: Date.now() };
    if (this.running) {
      this.queue.push(item);
      this.emit({ type: 'queue', queue: this.publicQueue() });
      return { queued: true };
    }
    this.start(item);
    return { queued: false };
  }

  removeQueued(id: string): void {
    this.queue = this.queue.filter((q) => q.id !== id);
    this.emit({ type: 'queue', queue: this.publicQueue() });
  }

  /**
   * Runs a command the user typed after "!" in the message box, in this
   * session's shell (so a cd carries over to the agent's Shell tool). The
   * command and its output join the conversation as context for the next
   * message; no model turn runs. It holds the session like a turn: input
   * sent meanwhile queues, and Stop ends the command.
   */
  runShell(command: string): void {
    if (this.disposed) throw new GraftError('session_closed', 'This session is closed.');
    if (this.summary.kind !== 'code') throw new GraftError('shell_unavailable', 'Shell commands run in code sessions.');
    const trimmed = command.trim();
    if (trimmed.length === 0) throw new GraftError('empty_message', 'Type a command after the !.');
    if (this.running) throw new GraftError('session_busy', 'Graft is working. Wait for it to finish, or stop it, then run the command.');
    this.running = this.execShell(trimmed).finally(() => this.afterTurn());
  }

  private async execShell(command: string): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const turnId = randomUUID();
    this.setStatus('running');
    this.emit({ type: 'turn-start', turnId, shell: command });
    let reason: 'completed' | 'interrupted' | 'error' = 'completed';
    try {
      const cwd = this.deps.shells.cwdFor(this.id, this.workingDir());
      const result = await this.deps.shells.run(this.id, command, { cwd, timeoutMs: USER_SHELL_TIMEOUT_MS, signal: controller.signal });
      if (result.interrupted) reason = 'interrupted';
      const output = result.output.replace(/\s+$/, '');
      const status = result.timedOut
        ? `timed out after ${USER_SHELL_TIMEOUT_MS / 1000}s`
        : result.interrupted
          ? 'stopped by the user'
          : `exit code ${result.exitCode ?? 'unknown'}`;
      const text = [
        `<user-shell-command cwd="${cwd}" status="${status}">`,
        `$ ${command}`,
        output.length > 0 ? output : '(no output)',
        '</user-shell-command>',
        "The user ran this command in the session's shell themselves. Its output is context for their next message, not a request."
      ].join('\n');
      const shown = output.slice(-USER_SHELL_SHOWN);
      const stored = this.deps.store.appendMessage(this.id, 'user', [{ type: 'text', text }], {
        kind: 'shell',
        turnId,
        shell: {
          command,
          cwd,
          exitCode: result.exitCode,
          output: shown,
          truncated: result.truncated || shown.length < output.length,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          interrupted: result.interrupted
        }
      });
      this.emit({ type: 'message', message: stored });
    } catch (error) {
      reason = 'error';
      this.notice('error', `Couldn't run the command: ${(error as Error).message}`);
    } finally {
      this.setStatus('idle');
      this.emit({ type: 'turn-end', turnId, reason });
    }
  }

  interrupt(): void {
    if (!this.controller) return;
    this.controller.abort();
    if (this.pendingPermission) {
      this.pendingPermission.resolve({ decision: 'deny' });
      this.pendingPermission = null;
    }
    if (this.pendingQuestion) {
      this.pendingQuestion.resolve(null);
      this.pendingQuestion = null;
    }
  }

  respondPermission(response: PermissionResponse): void {
    const pending = this.pendingPermission;
    if (!pending || pending.request.id !== response.requestId) {
      throw new GraftError('stale_request', 'That permission request is no longer pending.');
    }
    this.pendingPermission = null;
    const rule = pending.request.suggestedRule;
    if ((response.decision === 'allow-session' || response.decision === 'allow-always') && rule) this.sessionAllow.push(rule);
    if (response.decision === 'allow-always' && rule) {
      const root = this.settingsRoot();
      if (root) {
        this.deps.trust(root);
        this.deps.settings.addRule('local', root, 'allow', rule).catch((error: unknown) => {
          this.notice('warning', `Couldn't save the rule ${rule}: ${(error as Error).message}`);
        });
      }
    }
    this.emit({ type: 'permission-resolved', requestId: response.requestId });
    this.setStatus('running');
    pending.resolve({ decision: response.decision, ...(response.feedback ? { feedback: response.feedback } : {}) });
  }

  answerQuestion(response: QuestionResponse): void {
    const pending = this.pendingQuestion;
    if (!pending || pending.request.id !== response.requestId) {
      throw new GraftError('stale_request', 'That question is no longer pending.');
    }
    this.pendingQuestion = null;
    this.emit({ type: 'question-resolved', requestId: response.requestId });
    this.setStatus('running');
    pending.resolve(response.dismissed ? null : response.answers);
  }

  setPermissionMode(mode: PermissionMode): void {
    const current = this.summary.permissionMode;
    if (current === mode) return;
    if (mode === 'plan' && current !== 'plan') this.prePlanMode = current;
    this.deps.store.updateSession(this.id, { permissionMode: mode });
    this.notes.push(modeChangeNote(mode));
    this.emit({ type: 'mode', permissionMode: mode });
  }

  /** Shift+Tab: Ask → Auto-edit → Plan → Auto → Ask (Bypass is set explicitly only). */
  cyclePermissionMode(): PermissionMode {
    const current = this.summary.permissionMode;
    const cycle: PermissionMode[] = this.deps.preferences().bypassEnabled ? [...MODE_CYCLE, 'bypass'] : MODE_CYCLE;
    const next = cycle[(cycle.indexOf(current) + 1) % cycle.length] ?? 'ask';
    this.setPermissionMode(next);
    return next;
  }

  setModel(model: ModelRef, effort: EffortLevel | null): void {
    const previous = this.summary.effort;
    this.deps.store.updateSession(this.id, { model, effort });
    if (effort === 'taproot' && previous !== 'taproot') this.briefTaproot();
  }

  /** Queues the Taproot briefing for the next message unless this code session already has it. */
  private briefTaproot(): void {
    if (this.summary.kind !== 'code' || this.notes.includes(TAPROOT_NOTE)) return;
    const briefed = this.deps.store
      .listMessages(this.id)
      .some((m) => m.role === 'user' && m.content.some((b) => b.type === 'text' && b.text.startsWith(TAPROOT_MARKER)));
    if (!briefed) this.notes.push(TAPROOT_NOTE);
  }

  /** Retries the last failed turn without adding a new user message. */
  retry(): void {
    if (this.running) throw new GraftError('busy', 'The session is already running.');
    const messages = this.deps.store.listMessages(this.id);
    const last = messages.at(-1);
    if (!last) throw new GraftError('nothing_to_retry', 'There is nothing to retry.');
    if (last.role === 'assistant' && (last.meta.error || last.meta.interrupted)) this.deps.store.deleteMessagesFrom(this.id, last.seq);
    this.running = this.runTurn(null).finally(() => this.afterTurn());
  }

  /** Answers the last typed message again, replacing the reply that followed it. */
  regenerate(): void {
    if (this.running) throw new GraftError('busy', 'The session is already running.');
    const messages = this.deps.store.listMessages(this.id);
    const lastTyped = messages.findLast(
      (m) => m.role === 'user' && (m.meta.kind ?? 'normal') === 'normal' && m.content.some((b) => b.type === 'text' || b.type === 'image')
    );
    if (!lastTyped) throw new GraftError('nothing_to_retry', 'There is nothing to retry.');
    const reply = messages.find((m) => m.seq > lastTyped.seq);
    if (reply) this.deps.store.deleteMessagesFrom(this.id, reply.seq);
    this.running = this.runTurn(null).finally(() => this.afterTurn());
  }

  /** Removes messages from `seq` on (conversation rewind / edit-and-resubmit). */
  truncateFrom(seq: number): StoredMessage[] {
    if (this.running) throw new GraftError('busy', 'Stop the session before rewinding it.');
    const removed = this.deps.store.deleteMessagesFrom(this.id, seq);
    this.files.clear();
    return removed;
  }

  compactNow(instructions: string): void {
    if (this.running) throw new GraftError('busy', 'Wait for the current turn to finish, or stop it first.');
    this.start({ id: randomUUID(), text: `/compact ${instructions}`.trim(), images: [], files: [], createdAt: Date.now() });
  }

  async dispose(): Promise<void> {
    this.interrupt();
    await this.running?.catch(() => undefined);
    this.flushDeltas();
    this.disposed = true;
    await this.deps.shells.disposeSession(this.id);
  }

  // ---- turn orchestration -------------------------------------------------

  private start(item: InternalQueued): void {
    this.running = this.runTurn(item).finally(() => this.afterTurn());
  }

  private afterTurn(): void {
    this.running = null;
    this.controller = null;
    if (this.disposed || this.status === 'error') return;
    const next = this.queue.shift();
    if (next) {
      this.emit({ type: 'queue', queue: this.publicQueue() });
      this.start(next);
    }
  }

  /** Waits for the current turn (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /** Folder the agent works in and is sandboxed to (the worktree when there is one). */
  private projectRoot(): string | null {
    const s = this.summary;
    return s.worktreePath ?? s.projectPath ?? s.cwd ?? null;
  }

  /**
   * The project's main folder: where trust is recorded and where project and
   * local settings live. A worktree session shares its project's settings.
   */
  private settingsRoot(): string | null {
    const s = this.summary;
    return s.projectPath ?? this.projectRoot();
  }

  private workingDir(): string {
    const s = this.summary;
    return s.worktreePath ?? s.cwd ?? s.projectPath ?? process.cwd();
  }

  private async handleSlash(item: InternalQueued): Promise<{ text: string; typed: string | null } | null> {
    const slash = parseSlash(item.text);
    if (!slash) return { text: item.text, typed: null };
    const summary = this.summary;
    if (PROMPT_COMMANDS.has(slash.name)) {
      const custom = loadCustomCommands(this.deps.graftHome, this.projectRoot()).find((c) => c.name === slash.name);
      if (custom) return { text: expandCommand(custom, slash.args), typed: item.text };
    }
    if (UI_COMMANDS.has(slash.name)) {
      this.commandOutput(`/${slash.name} opens in the app: type it on its own, or use the command palette (Ctrl+Shift+P).`);
      return null;
    }
    switch (slash.name) {
      case 'clear': {
        const ids = this.deps.store.listMessages(this.id).filter((m) => !m.meta.compacted).map((m) => m.id);
        this.deps.store.markCompacted(this.id, ids);
        this.files.clear();
        this.deps.store.updateSession(this.id, { todos: [] });
        this.emit({ type: 'todos', todos: [] });
        this.commandOutput('Context cleared. Earlier messages stay visible but are no longer sent to the model.');
        return null;
      }
      case 'compact':
        await this.compact(slash.args, this.controller?.signal ?? new AbortController().signal);
        return null;
      case 'cost': {
        const u = summary.usage;
        const cost = u.costUsd !== null ? ` · about $${u.costUsd.toFixed(4)}` : ' · cost unknown for this provider';
        this.commandOutput(
          `Tokens this session: ${u.totals.inputTokens.toLocaleString()} input, ${u.totals.outputTokens.toLocaleString()} output, ${u.totals.cacheReadTokens.toLocaleString()} cache reads, ${u.totals.cacheWriteTokens.toLocaleString()} cache writes${cost}. Context: ${u.contextTokens.toLocaleString()} of ${u.contextLimit.toLocaleString()}.`
        );
        return null;
      }
      case 'help': {
        const lines = listCommands(this.deps.graftHome, this.projectRoot()).map((c) => `- /${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''} — ${c.description}`);
        this.commandOutput(
          `Commands:\n${lines.join('\n')}\n\nIn the message box: @ mentions a file, ! runs a shell command, ↑ brings back earlier messages, Shift+Tab cycles the permission mode and Esc stops the agent. Ctrl+Shift+P opens the command palette.`
        );
        return null;
      }
      case 'init':
        return { text: INIT_PROMPT, typed: item.text };
      case 'review':
        return { text: reviewPrompt(slash.args), typed: item.text };
      case 'security-review':
        return { text: securityReviewPrompt(slash.args), typed: item.text };
      case 'explain':
        return { text: explainPrompt(slash.args), typed: item.text };
      case 'test':
        return { text: testPrompt(slash.args), typed: item.text };
      case 'commit':
        return { text: commitPrompt(slash.args), typed: item.text };
      case 'pr':
        return { text: prPrompt(slash.args), typed: item.text };
      case 'permissions': {
        const mode = slash.args as PermissionMode;
        if ([...MODE_CYCLE, ...(this.deps.preferences().bypassEnabled ? ['bypass'] : [])].includes(mode)) {
          this.setPermissionMode(mode);
          this.commandOutput(`Permission mode set to ${mode}.`);
        } else {
          this.commandOutput('Usage: /permissions ask | auto-edit | plan | auto. Rules are edited in Settings → Permissions.');
        }
        return null;
      }
      case 'effort': {
        const level = slash.args as EffortLevel;
        if ((EFFORT_LEVELS as readonly string[]).includes(level) && summary.model) {
          this.setModel(summary.model, level);
          this.commandOutput(`Effort set to ${level}.`);
        } else {
          this.commandOutput(`Usage: /effort ${EFFORT_LEVELS.join(' | ')}`);
        }
        return null;
      }
      default: {
        const custom = loadCustomCommands(this.deps.graftHome, this.projectRoot()).find((c) => c.name === slash.name);
        if (!custom) {
          this.commandOutput(`Unknown command /${slash.name}. Type /help to see the available commands.`);
          return null;
        }
        return { text: expandCommand(custom, slash.args), typed: item.text };
      }
    }
  }

  private async resolveModel(signal: AbortSignal): Promise<{ provider: LLMProvider; model: ModelInfo; ref: ModelRef }> {
    const ref = this.summary.model ?? this.deps.preferences().defaultModel;
    if (!ref) throw new GraftError('no_model', 'Choose a model for this session first.');
    if (this.summary.incognito && this.deps.preferences().incognitoLocalOnly && this.deps.dataHandling(ref.providerId) !== 'local') {
      throw new GraftError(
        'incognito_local_only',
        `Incognito chats are set to use only models on this computer, and ${this.deps.providerName(ref.providerId)} isn't one. Pick a model from Ollama, LM Studio or another local server, or change this in Settings → Privacy.`
      );
    }
    const { provider, model } = await this.deps.models.resolve(ref, signal);
    return { provider, model, ref };
  }

  /**
   * Web access for this session and model. The search engine setting decides
   * where searches go: the WebSearch tool runs them, except that a model's
   * built-in search (Claude on Anthropic, the only adapter with one) runs when
   * Anthropic is the engine. WebFetch reads pages. Incognito chats get none,
   * so nothing goes to a search engine.
   */
  private webTools(model: ModelInfo): { native: boolean; clientSearch: boolean; fetch: boolean } {
    const summary = this.summary;
    const allowed = this.deps.preferences().webSearch && !summary.incognito && model.supportsTools;
    const engine = allowed ? this.deps.search.active() : null;
    const native = engine === 'anthropic' && model.supportsWebSearch;
    const clientSearch = engine !== null && !native;
    // Code sessions always had WebFetch (it asks first in Ask mode); chats get it with web access on.
    return { native, clientSearch, fetch: summary.kind === 'code' || allowed };
  }

  /** CreateFile and RunCode, for chats with a model that uses tools. Incognito chats get neither: they never write to disk. */
  private chatWork(model: ModelInfo): { files: boolean; code: boolean } {
    const summary = this.summary;
    const files = summary.kind === 'chat' && !summary.incognito && model.supportsTools && this.deps.chatFiles !== null;
    return { files, code: files && this.deps.runCode !== null };
  }

  /** Incognito asks for zero retention; otherwise the Privacy setting decides. */
  private privacy(): RequestPrivacy {
    const incognito = this.summary.incognito;
    return { noTraining: incognito || this.deps.preferences().noTraining, zeroRetention: incognito };
  }

  private effortFor(model: ModelInfo): EffortLevel | null {
    if (!model.effort) return null;
    let wanted = this.summary.effort ?? this.deps.preferences().defaultEffort;
    // Taproot is the long-horizon mode for code; a chat's highest effort is the model's strongest level.
    if (wanted === 'taproot' && this.summary.kind === 'chat') wanted = model.effort.levels.filter((l) => l !== 'taproot').at(-1) ?? model.effort.default;
    return model.effort.levels.includes(wanted) ? wanted : model.effort.default;
  }

  /** Computer use: code sessions with it switched on, on a model that can see screenshots. */
  private computerFor(model: ModelInfo): boolean {
    return this.summary.kind === 'code' && this.deps.computer !== null && this.deps.preferences().computerUse && model.supportsVision;
  }

  /** Tools a turn on this model offers: built-ins for the session kind, plus MCP tools in code sessions. */
  private toolsFor(model: ModelInfo): string[] {
    const summary = this.summary;
    const web = this.webTools(model);
    const work = this.chatWork(model);
    const computer = this.computerFor(model);
    const mcpTools = summary.kind === 'code' ? this.deps.mcpToolNames(this.settingsRoot()) : [];
    const chatOnly = new Set<string>(CHAT_ONLY_TOOLS);
    const builtins =
      summary.kind === 'code'
        ? this.deps.tools.names().filter((n) => !n.startsWith('mcp__') && !chatOnly.has(n) && (n !== 'WebSearch' || web.clientSearch) && (n !== 'Computer' || computer))
        : [...(web.fetch ? ['WebFetch'] : []), ...(web.clientSearch ? ['WebSearch'] : []), ...(work.files ? ['CreateFile'] : []), ...(work.code ? ['RunCode'] : [])];
    return [...builtins, ...mcpTools];
  }

  /** Builds the system prompt for this model; code sessions read project notes through the given loader. */
  private async composePrompt(model: ModelInfo, memory: MemoryLoader | null): Promise<string> {
    const identity = { label: model.label, id: model.ref.modelId, provider: this.deps.providerName(model.ref.providerId) };
    const summary = this.summary;
    const web = this.webTools(model);
    const prefs = this.deps.preferences();
    const root = this.projectRoot();
    if (summary.kind === 'code' && root && memory) {
      return buildCodeSystemPrompt({
        model: identity,
        cwd: this.workingDir(),
        projectRoot: root,
        platform: this.deps.platform,
        shellLabel: this.deps.shellLabel,
        git: await this.deps.gitInfo(this.workingDir()),
        date: this.deps.now().toISOString().slice(0, 10),
        mode: summary.permissionMode,
        memory: memory.initial(this.workingDir()),
        skills: loadSkills(this.deps.graftHome, root),
        webSearch: web.native || web.clientSearch,
        computer: this.computerFor(model),
        mcpServers: this.deps.mcpServerNames(this.settingsRoot()),
        personalization: prefs.personalization
      });
    }
    // An incognito chat doesn't tell the provider who is asking or what they wrote about themselves.
    return buildChatSystemPrompt({
      date: this.deps.now().toISOString().slice(0, 10),
      name: summary.incognito ? null : prefs.userName,
      model: identity,
      web: { search: web.native || web.clientSearch, fetch: web.fetch },
      workspace: this.chatWork(model),
      personalization: summary.incognito ? null : prefs.personalization
    });
  }

  private memoryLoader(): MemoryLoader | null {
    const root = this.projectRoot();
    return this.summary.kind === 'code' && root ? new MemoryLoader(this.deps.graftHome, root, this.deps.platform) : null;
  }

  /**
   * What the next turn sends as its system prompt and tools, for Session →
   * View system prompt. Reuses the session's prompt when it was built for the
   * current model; otherwise builds one without keeping it, so a preview
   * never changes what a turn sends.
   */
  async promptPreview(): Promise<{ system: string; tools: string[]; model: string }> {
    const { model, ref } = await this.resolveModel(new AbortController().signal);
    const tools = this.toolsFor(model);
    const label = `${model.label} via ${this.deps.providerName(ref.providerId)}`;
    if (this.system && this.modelKey === `${ref.providerId}:${ref.modelId}`) return { system: this.system, tools, model: label };
    return { system: await this.composePrompt(model, this.memoryLoader()), tools, model: label };
  }

  /**
   * System prompt and tool list are built once and then kept stable; a model
   * switch rebuilds them (the provider cache is lost then anyway) so the
   * prompt always names the model that is answering.
   */
  private async ensurePrompt(model: ModelInfo): Promise<{ system: string; toolNames: string[] }> {
    const toolNames = this.toolsFor(model);
    if (!this.system) {
      this.memory = this.memoryLoader();
      this.system = await this.composePrompt(model, this.memory);
    }
    const key = `${this.system.length}:${toolNames.join(',')}`;
    if (this.promptKey !== null && this.promptKey !== key) this.markThinkingStale();
    this.promptKey = key;
    this.toolNames = toolNames;
    return { system: this.system, toolNames };
  }

  private markThinkingStale(): void {
    this.stripBeforeSeq = (this.deps.store.listMessages(this.id).at(-1)?.seq ?? 0) + 1;
  }

  private history(): LlmMessage[] {
    const messages = this.deps.store.listMessages(this.id);
    const floor = this.stripBeforeSeq;
    const kept = messages.map((m) =>
      m.seq < floor && m.role === 'assistant' ? { ...m, content: m.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking') } : m
    );
    return toLlmHistory(this.summary.kind === 'chat' ? withSentTimes(kept) : kept);
  }

  private async runTurn(item: InternalQueued | null): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;
    const turnId = randomUUID();
    this.setStatus('running');
    this.emit({ type: 'turn-start', turnId });
    let endReason: 'completed' | 'interrupted' | 'error' | 'guard' = 'completed';
    try {
      const summary = this.summary;
      const root = this.projectRoot();
      const settingsRoot = this.settingsRoot();
      const trusted = settingsRoot ? this.deps.isTrusted(settingsRoot) : false;
      const hooks = summary.kind === 'code' ? this.deps.hooks(settingsRoot, trusted) : null;

      let userText: string | null = null;
      if (item) {
        const handled = await this.handleSlash(item);
        if (!handled) return;
        userText = handled.text;
        // A session that starts in Taproot (or reopens in it) gets the briefing with its first message.
        if ((summary.effort ?? this.deps.preferences().defaultEffort) === 'taproot') this.briefTaproot();
        if (hooks?.has('UserPromptSubmit')) {
          const verdict = await hooks.run('UserPromptSubmit', { session_id: this.id, prompt: userText }, signal);
          for (const e of verdict.errors) this.notice('warning', e);
          if (verdict.decision === 'block') {
            this.notice('error', `Your message was blocked by a UserPromptSubmit hook: ${verdict.reason ?? 'no reason given'}`);
            return;
          }
          if (verdict.context) this.notes.push(verdict.context);
        }
        const userMessageId = randomUUID();
        let checkpointId: string | null = null;
        if (summary.kind === 'code') {
          try {
            checkpointId = await this.deps.checkpoint(this.id, this.workingDir(), userMessageId);
          } catch (error) {
            this.notice('warning', `Couldn't create a checkpoint before this turn: ${(error as Error).message}`);
          }
        }
        const content: ContentBlock[] = [...this.notes.map((text) => ({ type: 'text' as const, text })), ...item.images];
        if (userText.length > 0) content.push({ type: 'text', text: userText });
        for (const file of item.files) {
          content.push({ type: 'text', text: `<attached-file name="${file.name.replace(/"/g, "'")}">\n${file.content}\n</attached-file>` });
        }
        if (summary.kind === 'code' && root && userText.includes('@')) {
          const mentions = expandMentions(userText, this.workingDir(), root, this.deps.platform);
          for (const block of mentions.blocks) content.push({ type: 'text', text: block });
          for (const file of mentions.files) this.files.record(file);
        }
        this.notes = [];
        // The transcript shows what was typed; notes and attachments travel only to the model.
        const meta: MessageMeta = {
          turnId,
          typed: handled.typed ?? item.text,
          ...(item.files.length > 0 ? { attachments: item.files.map((f) => f.name) } : {}),
          ...(checkpointId ? { checkpointId } : {})
        };
        const stored = this.deps.store.appendMessage(this.id, 'user', content, meta, userMessageId);
        this.emit({ type: 'message', message: stored });
      }

      const { provider, model, ref } = await this.resolveModel(signal);
      const key = `${ref.providerId}:${ref.modelId}`;
      if (this.modelKey !== null && this.modelKey !== key) {
        this.markThinkingStale();
        this.system = null;
      }
      this.modelKey = key;
      if (summary.kind === 'code' && !model.supportsTools) {
        throw new GraftError('model_no_tools', `${model.label} can't use tools, so it can't work on code. Pick a different model.`);
      }
      const { system, toolNames } = await this.ensurePrompt(model);
      const effort = this.effortFor(model);
      const host = this.makeHost(model, provider, hooks, root, trusted);
      const result = await runAgentLoop(
        this.history(),
        {
          provider,
          model,
          registry: this.deps.tools,
          toolNames,
          system,
          effort,
          webSearch: this.webTools(model).native,
          cacheKey: this.id,
          privacy: this.privacy(),
          turnId,
          maxIterations: effort === 'taproot' ? TAPROOT_ITERATIONS : MAX_ITERATIONS,
          agentLabel: null,
          ...(this.deps.retryPolicy ? { retryPolicy: this.deps.retryPolicy } : {}),
          taproot: effort === 'taproot',
          stripThinking: false,
          sessionId: this.id
        },
        host,
        signal
      );
      endReason = result.reason;
      if (result.reason === 'error' && result.error) {
        this.setStatus('error', result.error);
        this.deps.notify(this.summary, 'error', result.error.message);
        return;
      }
      if (result.reason === 'completed' && userText !== null) this.maybeTitle(userText);
      if (result.reason === 'completed' || result.reason === 'guard') this.deps.notify(this.summary, 'finished', result.finalText.slice(0, 140));
    } catch (error) {
      if (signal.aborted) {
        endReason = 'interrupted';
        return;
      }
      endReason = 'error';
      const info =
        error instanceof GraftError
          ? { code: error.code, message: error.message }
          : { code: (error as { code?: string }).code ?? 'internal', message: (error as Error).message };
      this.deps.log('error', 'Turn failed', { session: this.id, message: info.message });
      this.setStatus('error', info);
      this.deps.notify(this.summary, 'error', info.message);
    } finally {
      if (this.status !== 'error') this.setStatus('idle');
      this.emit({ type: 'turn-end', turnId, reason: endReason });
    }
  }

  private maybeTitle(firstText: string): void {
    const summary = this.summary;
    if (!DEFAULT_TITLES.has(summary.title)) return;
    // Only typed messages count; tool results are stored as user messages too.
    const typed = this.deps.store
      .listMessages(this.id)
      .filter((m) => m.role === 'user' && (m.meta.kind ?? 'normal') === 'normal' && m.content.some((b) => b.type === 'text' || b.type === 'image'));
    if (typed.length !== 1) return;
    if (summary.incognito) {
      // Named from the message itself: an incognito chat isn't sent out again just for a title.
      const title = cleanTitle(firstText);
      if (!title) return;
      this.deps.store.updateSession(this.id, { title });
      this.emit({ type: 'title', title });
      return;
    }
    this.deps.generateTitle(summary, firstText);
  }

  // ---- compaction ---------------------------------------------------------

  private async compact(instructions: string, signal: AbortSignal): Promise<LlmMessage[] | null> {
    const { provider, model } = await this.resolveModel(signal);
    const messages = this.deps.store.listMessages(this.id).filter((m) => !m.meta.compacted && m.meta.kind !== 'command-output');
    if (messages.length < 2) {
      this.commandOutput('Nothing to compact yet.');
      return null;
    }
    this.notice('info', 'Compacting the conversation…');
    const todos = this.deps.store.getTodos(this.id);
    const summaryText = await summarizeSession({
      provider,
      model,
      messages,
      todos,
      files: this.files.touchedFiles(),
      instructions,
      cacheKey: this.id,
      privacy: this.privacy(),
      signal
    });
    this.deps.store.markCompacted(
      this.id,
      messages.map((m) => m.id)
    );
    const text = summaryMessageText(summaryText, todos, this.files.touchedFiles());
    const stored = this.deps.store.appendMessage(this.id, 'user', [{ type: 'text', text }], { kind: 'compaction-summary' });
    this.files.clear();
    this.markThinkingStale();
    this.emit({ type: 'message', message: stored });
    this.emit({ type: 'compacted', summaryMessageId: stored.id });
    return [{ role: 'user', content: [{ type: 'text', text }] }];
  }

  // ---- loop host ----------------------------------------------------------

  private permissionEnv(root: string | null, trusted: boolean) {
    const { rules, problems } = this.deps.settings.rules(this.settingsRoot(), trusted, this.sessionAllow);
    for (const p of problems) this.deps.log('warn', 'Settings problem', { message: p });
    return {
      mode: this.summary.permissionMode,
      projectRoot: root ?? this.workingDir(),
      platform: this.deps.platform,
      rules,
      bypassKeepsChecks: this.deps.preferences().bypassKeepsChecks,
      allowNetwork: this.summary.kind === 'chat'
    };
  }

  private prompt(request: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve({ decision: 'deny' });
        return;
      }
      this.pendingPermission = { request, resolve };
      this.setStatus('needs-input');
      this.emit({ type: 'permission', request });
      this.deps.notify(this.summary, 'needs-input', request.title);
    });
  }

  private makeHost(model: ModelInfo, provider: LLMProvider, hooks: HookRunner | null, root: string | null, trusted: boolean): LoopHost {
    const cwd = this.workingDir();
    const describeContext = { cwd, projectRoot: root ?? cwd, platform: this.deps.platform };
    const host: LoopHost = {
      append: (role, content, meta, id) => this.deps.store.appendMessage(this.id, role, content, meta, id),
      emit: (event) => this.emit(event),
      decide: (query) => decide(query, this.permissionEnv(root, trusted)),
      askPermission: (prompt: PermissionPrompt, signal) =>
        this.prompt(
          {
            id: randomUUID(),
            sessionId: this.id,
            toolUseId: prompt.toolUseId,
            toolName: prompt.toolName,
            title: prompt.title,
            detail: prompt.detail,
            reason: prompt.decision.reason,
            dangerous: prompt.decision.dangerous,
            outsideProject: prompt.decision.outsideProject,
            suggestedRule: prompt.decision.suggestedRule,
            agentLabel: prompt.agentLabel
          },
          signal
        ),
      toolContext: (toolUseId, signal) => this.toolContext(toolUseId, signal, model, provider, hooks, root, trusted),
      describeContext: () => describeContext,
      hooks,
      todos: () => this.deps.store.getTodos(this.id),
      maybeCompact: async (_history, tokens, signal) => {
        if (!this.deps.preferences().autoCompact || !shouldCompact(tokens, model.contextWindow)) return null;
        return this.compact('', signal);
      },
      onUsage: (usage: Usage, contextTokens: number | null, costUsd: number | null) => {
        const current = this.summary.usage;
        const next = {
          totals: addUsage(current.totals, usage),
          contextTokens: contextTokens ?? current.contextTokens,
          contextLimit: contextTokens === null ? current.contextLimit : model.contextWindow,
          costUsd: costUsd === null ? current.costUsd : (current.costUsd ?? 0) + costUsd
        };
        this.deps.store.updateSession(this.id, { usage: next });
        this.emit({ type: 'usage', usage: next });
      },
      log: (level, message, fields) => this.deps.log(level, message, { session: this.id, ...fields })
    };
    return host;
  }

  private toolContext(
    toolUseId: string,
    signal: AbortSignal,
    model: ModelInfo,
    provider: LLMProvider,
    hooks: HookRunner | null,
    root: string | null,
    trusted: boolean
  ): ToolContext {
    const cwd = this.workingDir();
    const work = this.chatWork(model);
    return {
      sessionId: this.id,
      toolUseId,
      cwd,
      projectRoot: root ?? cwd,
      platform: this.deps.platform,
      signal,
      files: this.files,
      shells: this.deps.shells,
      rgPath: this.deps.rgPath,
      modelSupportsVision: model.supportsVision,
      todos: {
        get: () => this.deps.store.getTodos(this.id),
        set: (todos: TodoItem[]) => {
          this.deps.store.updateSession(this.id, { todos });
          this.emit({ type: 'todos', todos });
        }
      },
      progress: (chunk) => this.emit({ type: 'tool-progress', toolUseId, chunk }),
      askUser: (questions) =>
        new Promise((resolve) => {
          if (signal.aborted) {
            resolve(null);
            return;
          }
          const request: QuestionRequest = { id: randomUUID(), sessionId: this.id, toolUseId, questions };
          this.pendingQuestion = { request, resolve };
          this.setStatus('needs-input');
          this.emit({ type: 'question', request });
          this.deps.notify(this.summary, 'needs-input', questions[0]?.question ?? 'The agent has a question');
        }),
      approvePlan: async (plan) => {
        const decision: Decision = { behavior: 'ask', reason: 'Approve the plan to leave plan mode.', dangerous: null, outsideProject: false, suggestedRule: null };
        const answer = await this.prompt(
          {
            id: randomUUID(),
            sessionId: this.id,
            toolUseId,
            toolName: 'ExitPlanMode',
            title: 'Approve this plan?',
            detail: { kind: 'plan', plan },
            reason: decision.reason,
            dangerous: null,
            outsideProject: false,
            suggestedRule: null,
            agentLabel: null
          },
          signal
        );
        if (answer.decision === 'deny') return { approved: false, feedback: answer.feedback ?? null };
        const mode = this.prePlanMode === 'plan' ? 'auto-edit' : this.prePlanMode;
        this.deps.store.updateSession(this.id, { permissionMode: mode });
        this.emit({ type: 'mode', permissionMode: mode });
        return { approved: true, feedback: null };
      },
      runSubagent: (input) => this.runSubagent(input, toolUseId, signal, model, provider, hooks, root, trusted),
      notesForPaths: (paths) => this.memory?.notesFor(paths) ?? null,
      search: (query, count, searchSignal) => this.deps.search.search(query, count, searchSignal),
      computer: this.deps.computer,
      chatFiles: work.files && this.deps.chatFiles ? { save: (name, data) => this.deps.chatFiles!.save(this.id, name, data) } : null,
      runCode: work.code ? this.deps.runCode : null
    };
  }

  private async runSubagent(
    input: { description: string; prompt: string; type: SubagentType },
    parentToolUseId: string,
    signal: AbortSignal,
    model: ModelInfo,
    provider: LLMProvider,
    hooks: HookRunner | null,
    root: string | null,
    trusted: boolean
  ): Promise<{ text: string; toolCalls: number }> {
    const parentOnly = new Set<string>(PARENT_ONLY_TOOLS);
    // A sub-agent never gets more than the session has (e.g. no WebSearch without a search engine).
    const available = this.toolNames ?? this.deps.tools.names();
    const toolNames =
      input.type === 'explore' ? READ_ONLY_TOOLS.filter((n) => available.includes(n)) : available.filter((n) => !parentOnly.has(n));
    const system = `${this.system ?? ''}\n\n# Delegated task\nYou are a sub-agent working on one task for the main agent: "${input.description}". You have a fresh context; the main agent sees only your final message, so make it a complete, self-contained report (findings with path:line references, changes made, anything unresolved).${input.type === 'explore' ? ' You are read-only: research and report; do not try to change anything.' : ''}`;
    const scratch: StoredMessage[] = [];
    const parent = this.makeHost(model, provider, hooks, root, trusted);
    const host: LoopHost = {
      ...parent,
      append: (role, content, meta, id) => {
        const message: StoredMessage = { id: id ?? randomUUID(), sessionId: this.id, seq: scratch.length + 1, role, content, meta, createdAt: Date.now() };
        scratch.push(message);
        return message;
      },
      emit: (event) => {
        if (event.type === 'tool-start') this.emit({ type: 'tool-progress', toolUseId: parentToolUseId, chunk: `${event.summary}\n` });
        else if (event.type === 'notice') this.emit(event);
      },
      maybeCompact: () => Promise.resolve(null),
      todos: () => [],
      // A subagent's spend counts toward the session; its context size isn't the conversation's.
      onUsage: (usage, _tokens, costUsd) => parent.onUsage(usage, null, costUsd)
    };
    const result = await runAgentLoop(
      [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
      {
        provider,
        model,
        registry: this.deps.tools,
        toolNames,
        system,
        effort: this.effortFor(model) === 'taproot' ? (model.effort?.levels.includes('max') ? 'max' : model.effort?.default ?? null) : this.effortFor(model),
        webSearch: false,
        cacheKey: `${this.id}:${parentToolUseId}`,
        privacy: this.privacy(),
        turnId: parentToolUseId,
        maxIterations: SUBAGENT_ITERATIONS,
        agentLabel: input.description,
        taproot: false,
        stripThinking: false,
        sessionId: this.id
      },
      host,
      signal
    );
    if (result.reason === 'error') throw new GraftError('subagent_failed', `The sub-agent failed: ${result.error?.message ?? 'unknown error'}`);
    if (result.reason === 'interrupted') throw new GraftError('interrupted', 'Interrupted by the user.');
    return { text: result.finalText, toolCalls: result.toolCalls };
  }
}

