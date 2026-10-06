import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '@shared/schemas/agentEvents';
import { addUsage, EFFORT_LEVELS, type EffortLevel, type ModelRef, type PermissionMode, type Usage } from '@shared/schemas/common';
import { type CheckReport, type ContentBlock, type FileAttachment, type ImageBlock, type LlmMessage, type MessageMeta, type StoredMessage } from '@shared/schemas/messages';
import { MISSION_LIMITS, missionOpen, type Mission, type MissionStart } from '@shared/schemas/missions';
import type { ChecksConfig } from '@shared/schemas/config';
import { FORWARDED_PORTS, sandboxUrl, type SandboxSettings, type SandboxTarget } from '../sandbox/sandbox';
import type { BrowserPanel } from '../browser/browserPanel';
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
import type { AgentBrowser, SubagentType, ToolContext } from '../tools/types';
import { CHAT_ONLY_TOOLS, PARENT_ONLY_TOOLS, READ_ONLY_TOOLS } from '../tools/builtin';
import type { ChatFile } from '../chat/chatFiles';
import type { DocumentMaker } from '../chat/documents';
import type { MediaAccess } from '../media/mediaService';
import type { CodeRun } from '../chat/codeSandbox';
import { summarizeSession, summaryMessageText } from './compaction';
import { checksSummary, runChecks } from './checks';
import type { HookRunner } from './hooks';
import { toLlmHistory, withSentTimes } from './history';
import { runAgentLoop, type LoopHost, type PermissionAnswer, type PermissionPrompt } from './loop';
import type { McpPromptInfo } from '../mcp/mcpManager';
import { mcpPromptCommand, promptArguments, promptHint } from '../mcp/names';
import { expandMentions } from './mentions';
import { BUILTIN_AGENTS, loadAgents, subagentTools } from './agents';
import { runAgentGroup, type AgentGroupInput, type AgentGroupSettings } from './agentGroup';
import type { GraphControl } from './orchestrator';
import {
  afterMissionChecks,
  afterMissionTurn,
  applyMissionUpdate,
  cancelMission,
  createMission,
  missionBrief,
  missionCheckFailure,
  missionContinuation,
  pauseMission,
  resumeMission,
  type MissionUpdateInput,
  type TurnEnd
} from './mission';
import { MemoryLoader } from './memory';
import { loadSkills } from './skills';
import {
  commitPrompt,
  decompilePrompt,
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
import { estimateTextTokens, shouldCompact } from './tokens';
import { searchTools, type SearchableTool } from '../tools/toolSearch';

export interface ModelResolver {
  resolve(ref: ModelRef, signal?: AbortSignal): Promise<{ provider: LLMProvider; model: ModelInfo }>;
  /** Every model the user can use now, for choosing an agent's model. Absent: only the session's model is known. */
  candidates?(signal?: AbortSignal): Promise<ModelInfo[]>;
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
  /** Settings → Permissions → Steps per turn; null means no limit. */
  maxSteps: number | null;
  /** Settings → Models → Agents: how groups of agents are routed and limited. */
  agents: AgentGroupSettings;
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
  /** What the servers visible to the project say about using themselves. */
  mcpInstructions(projectRoot: string | null): Array<{ server: string; text: string }>;
  /** The prompts those servers publish (slash commands), and the filling in of one. */
  mcpPrompts(projectRoot: string | null): McpPromptInfo[];
  mcpPrompt(server: string, name: string, args: Record<string, string>, projectRoot: string | null): Promise<{ text: string; description: string | null }>;
  shells: ShellManager;
  shellLabel: string;
  settings: SettingsStore;
  hooks(projectRoot: string | null, trusted: boolean): HookRunner | null;
  rgPath: string;
  graftHome: string;
  platform: NodeJS.Platform;
  isTrusted(projectRoot: string): boolean;
  trust(projectRoot: string): void;
  /** The sandbox settings when this project runs its commands in a sandbox; null runs them on this computer. Absent: no sandbox. */
  sandbox?(projectRoot: string): SandboxSettings | null;
  /** The site from the Sites tab that this folder holds, with its live address; null for other folders. */
  site?(projectRoot: string): Promise<{ name: string; url: string } | null>;
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
  chatFiles: { save(sessionId: string, name: string, data: Buffer): ChatFile; image?(sessionId: string, name: string): { mime: string; data: Buffer } | null } | null;
  /** Builds the documents CreateFile makes from Markdown or rows; null where there are none. */
  documents: DocumentMaker | null;
  /** Image models and ComfyUI for the GenerateImage and ComfyUI tools (Settings → Images); null where unavailable. */
  media: MediaAccess | null;
  /** RunCode's sandbox: JavaScript in an isolated page; null where unavailable. */
  runCode: ((code: string, timeoutMs: number, signal: AbortSignal) => Promise<CodeRun>) | null;
  /** The Browser panel for the Browser tool (null while there's no window). Absent: no Browser tool. */
  browser?(): BrowserPanel | null;
  /** Shows the Browser panel in a session's view, when the agent opens a page there. */
  revealBrowser?(sessionId: string): void;
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
  /** A turn of a mission: its start, a later turn (with what the agent is told), or the checks on a report of "done". */
  mission?: { kind: 'start'; input: MissionStart } | { kind: 'step'; text: string; turn: number; of: number } | { kind: 'verify' };
}

/** How long one of a mission's checks may run. */
const MISSION_CHECK_TIMEOUT_SEC = 600;

/** A sub-agent's steps when Settings sets no limit: it reports back on one delegated task, so it stays bounded. */
const SUBAGENT_ITERATIONS = 200;
/** MCP tool definitions weighing more than this (or a tenth of the model's window) wait to be loaded with ToolSearch. */
const DEFER_MCP_TOKENS = 10_000;
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
  /** Queued messages sent with "Send now": they join the running turn after its next tool step. */
  private steering: InternalQueued[] = [];
  private pendingPermission: { request: PermissionRequest; resolve: (a: PermissionAnswer) => void } | null = null;
  private pendingQuestion: { request: QuestionRequest; resolve: (a: QuestionAnswer[] | null) => void } | null = null;
  private readonly sessionAllow: string[] = [];
  /** The groups of agents running now, by the RunAgents call that started each: how one agent of a group is stopped. */
  private readonly agentGroups = new Map<string, GraphControl>();
  readonly files: FileStateTracker;
  private memory: MemoryLoader | null = null;
  private system: string | null = null;
  private toolNames: string[] | null = null;
  /** The MCP tools of a setup too big to send with every request wait to be loaded; once they do, they do for the session. */
  private mcpDeferred = false;
  private readonly loadedMcp = new Set<string>();
  private promptKey: string | null = null;
  private modelKey: string | null = null;
  /** Thinking in messages before this seq is never replayed (model switch, tool set change). */
  private stripBeforeSeq = 0;
  private notes: string[] = [];
  private prePlanMode: PermissionMode = 'auto-edit';
  private deltaBuffer: { messageId: string; kind: 'text' | 'thinking'; text: string } | null = null;
  private deltaTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  /** How the last turn ended, for what a mission does next. */
  private lastTurn: { end: TurnEnd; error: string | null } = { end: 'completed', error: null };
  /** The permission request on screen and those behind it (see prompt). */
  private promptChain: Promise<unknown> = Promise.resolve();

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
      queue: this.publicQueue(),
      agentRuns: this.deps.store.listAgentRuns(this.id),
      mission: this.deps.store.getMission(this.id)
    };
  }

  private publicQueue(): QueuedInput[] {
    const view = (q: InternalQueued, steer: boolean): QueuedInput => ({ id: q.id, text: q.text, attachmentCount: q.images.length + q.files.length, createdAt: q.createdAt, steer });
    return [...this.steering.map((q) => view(q, true)), ...this.queue.map((q) => view(q, false))];
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
    this.steering = this.steering.filter((q) => q.id !== id);
    this.emit({ type: 'queue', queue: this.publicQueue() });
  }

  /**
   * "Send now" for a queued message: instead of waiting for the turn to end,
   * it reaches the agent right after its next tool step, without stopping
   * any work. With no turn running it is simply sent.
   */
  steer(id: string): void {
    const index = this.queue.findIndex((q) => q.id === id);
    if (index < 0) throw new GraftError('not_queued', 'That message is no longer waiting.');
    const item = this.queue[index]!;
    if (parseSlash(item.text)) throw new GraftError('cannot_steer', 'Commands run once the current turn ends.');
    this.queue.splice(index, 1);
    if (!this.running) {
      this.emit({ type: 'queue', queue: this.publicQueue() });
      this.start(item);
      return;
    }
    this.steering.push(item);
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
      await this.syncSandbox();
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
      this.lastTurn = { end: reason, error: null };
      this.setStatus('idle');
      this.emit({ type: 'turn-end', turnId, reason });
    }
  }

  interrupt(): void {
    if (!this.controller) return;
    this.controller.abort();
    // Stop also answers whatever the turn is waiting on. The matching *-resolved
    // events matter: without them the prompt card stays on screen with no way to
    // answer it, because the request it refers to is already gone.
    if (this.pendingPermission) {
      const { request } = this.pendingPermission;
      this.pendingPermission.resolve({ decision: 'deny' });
      this.pendingPermission = null;
      this.emit({ type: 'permission-resolved', requestId: request.id });
    }
    if (this.pendingQuestion) {
      const { request } = this.pendingQuestion;
      this.pendingQuestion.resolve(null);
      this.pendingQuestion = null;
      this.emit({ type: 'question-resolved', requestId: request.id });
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
    // The agents those turns started go with them.
    const first = removed[0];
    if (first) {
      this.deps.store.deleteAgentRunsFrom(this.id, first.createdAt);
      const before = this.deps.store.getMission(this.id);
      this.deps.store.deleteMissionsFrom(this.id, first.createdAt);
      const after = this.deps.store.getMission(this.id);
      if (after?.id !== before?.id) this.emit({ type: 'mission', mission: after });
    }
    this.files.clear();
    return removed;
  }

  compactNow(instructions: string): void {
    if (this.running) throw new GraftError('busy', 'Wait for the current turn to finish, or stop it first.');
    this.start({ id: randomUUID(), text: `/compact ${instructions}`.trim(), images: [], files: [], createdAt: Date.now() });
  }

  async dispose(): Promise<void> {
    // Mark closed before awaiting: the turn that is running ends during the wait,
    // and without this its successor would pick up the next queued message and
    // keep writing to a session that is being removed.
    this.disposed = true;
    this.interrupt();
    await this.idle();
    this.flushDeltas();
    await this.deps.shells.disposeSession(this.id);
  }

  // ---- missions -----------------------------------------------------------

  private saveMission(mission: Mission): void {
    this.deps.store.saveMission(mission);
    this.emit({ type: 'mission', mission });
  }

  private missionItem(mission: NonNullable<InternalQueued['mission']>, text = ''): InternalQueued {
    return { id: randomUUID(), text, images: [], files: [], createdAt: Date.now(), mission };
  }

  /**
   * Starts a mission: the objective goes to the agent with how a mission works,
   * and from then on a turn that ends without finishing it is followed by the
   * next, until its checks pass, it is paused, or it runs out of turns.
   */
  startMission(input: MissionStart): { queued: boolean } {
    if (this.disposed) throw new GraftError('session_closed', 'This session is closed.');
    if (this.summary.kind !== 'code' || !this.projectRoot()) throw new GraftError('mission_unavailable', 'Missions run in code sessions that have a project folder.');
    const current = this.deps.store.getMission(this.id);
    if ((current && missionOpen(current.status)) || this.queue.some((q) => q.mission?.kind === 'start')) {
      throw new GraftError('mission_exists', 'This session already has a mission. Finish or stop it before starting another.');
    }
    const item = this.missionItem({ kind: 'start', input }, input.objective);
    if (this.running) {
      this.queue.push(item);
      this.emit({ type: 'queue', queue: this.publicQueue() });
      return { queued: true };
    }
    this.start(item);
    return { queued: false };
  }

  /** Pauses the mission. A turn that is running finishes its work; nothing follows it until the mission is resumed. */
  pauseMission(): void {
    const mission = this.deps.store.getMission(this.id);
    if (mission?.status !== 'active') throw new GraftError('no_mission', 'There is no mission running to pause.');
    this.saveMission(pauseMission(mission, 'You paused it.', Date.now()));
  }

  /** Resumes a paused mission; one that had used all of its turns gets `extraTurns` more. */
  resumeMission(extraTurns: number = MISSION_LIMITS.moreTurns): void {
    if (this.disposed) throw new GraftError('session_closed', 'This session is closed.');
    const mission = this.deps.store.getMission(this.id);
    if (mission?.status !== 'paused') throw new GraftError('no_mission', 'There is no paused mission to resume.');
    this.saveMission(resumeMission(mission, extraTurns, Date.now()));
    // While a turn runs, its end carries the mission on.
    if (this.running) return;
    this.lastTurn = { end: 'completed', error: null };
    const follow = this.missionFollowUp();
    if (follow) this.start(follow);
  }

  /** Ends the mission for good, and stops the turn that is working on it. */
  cancelMission(): void {
    const mission = this.deps.store.getMission(this.id);
    if (!mission || !missionOpen(mission.status)) throw new GraftError('no_mission', 'There is no mission to stop.');
    this.saveMission(cancelMission(mission, Date.now()));
    this.queue = this.queue.filter((q) => !q.mission);
    this.interrupt();
  }

  /** A MissionUpdate call from the agent. */
  private updateMission(input: MissionUpdateInput): { reply: string; isError: boolean } {
    const mission = this.deps.store.getMission(this.id);
    if (!mission) return { reply: 'There is no mission running in this session.', isError: true };
    const next = applyMissionUpdate(mission, input, Date.now());
    if (next.mission !== mission) this.saveMission(next.mission);
    if (!next.isError && input.status === 'blocked') this.deps.notify(this.summary, 'needs-input', `Mission blocked: ${input.summary ?? ''}`.slice(0, 200));
    return { reply: next.reply, isError: next.isError };
  }

  /**
   * What the mission does now that a turn ended: it pauses (a stop, a failure,
   * no turns left), ends (done, with nothing to check), or goes on, in which
   * case this returns the turn to start.
   */
  private missionFollowUp(): InternalQueued | null {
    // A session being closed leaves its mission as it is: it comes back paused the next time Graft starts.
    if (this.disposed) return null;
    const mission = this.deps.store.getMission(this.id);
    if (!mission) return null;
    const next = afterMissionTurn(mission, this.lastTurn.end, Date.now(), this.lastTurn.error ?? undefined);
    if (next.mission !== mission) this.saveMission(next.mission);
    switch (next.action) {
      case 'none':
        return null;
      case 'stop':
        this.deps.notify(this.summary, 'needs-input', `Mission paused: ${next.mission.reason ?? ''}`.slice(0, 200));
        return null;
      case 'done':
        this.missionDone(next.mission);
        return null;
      case 'verify':
        return this.missionItem({ kind: 'verify' });
      case 'continue':
        return this.missionItem({ kind: 'step', text: missionContinuation(next.mission), turn: next.mission.turns, of: next.mission.maxTurns });
    }
  }

  private missionDone(mission: Mission): void {
    this.deps.log('info', 'Mission done', { session: this.id, turns: mission.turns });
    this.deps.notify(this.summary, 'finished', `Mission done: ${mission.objective}`.slice(0, 200));
  }

  /**
   * Runs the mission's checks on the agent's report of "done". Returns what
   * the agent is told when they fail, or null when the turn has nothing more
   * to do (they passed, the mission paused, or the turn was stopped).
   */
  private async verifyMission(turnId: string, signal: AbortSignal): Promise<{ text: string; turn: number; of: number } | null> {
    const mission = this.deps.store.getMission(this.id);
    if (mission?.status !== 'active' || !mission.claimed) return null;
    const round = (mission.verification?.round ?? 0) + 1;
    this.emit({ type: 'checks', commands: mission.checks, round });
    let report: CheckReport;
    try {
      await this.syncSandbox();
      report = await runChecks({ commands: mission.checks, fix: true, timeoutSec: MISSION_CHECK_TIMEOUT_SEC }, round, {
        sessionId: this.id,
        cwd: this.workingDir(),
        signal,
        shells: this.deps.shells
      });
    } catch (error) {
      if (signal.aborted) return null;
      const reason = `Its checks couldn't run: ${(error as Error).message}`;
      this.saveMission(pauseMission(mission, reason, Date.now()));
      this.deps.notify(this.summary, 'needs-input', `Mission paused: ${reason}`.slice(0, 200));
      return null;
    }
    // Stopped part-way: the turn ends as interrupted, which pauses the mission with its report still standing.
    if (signal.aborted) return null;
    const stored = this.deps.store.appendMessage(this.id, 'user', [{ type: 'text', text: checksSummary(report) }], { turnId, kind: 'check', check: report });
    this.emit({ type: 'message', message: stored });
    const next = afterMissionChecks(mission, report, Date.now());
    this.saveMission(next.mission);
    if (next.action === 'done') {
      this.missionDone(next.mission);
      return null;
    }
    if (next.action === 'stop') {
      this.deps.notify(this.summary, 'needs-input', `Mission paused: ${next.mission.reason ?? ''}`.slice(0, 200));
      return null;
    }
    return { text: missionCheckFailure(next.mission, report), turn: next.mission.turns, of: next.mission.maxTurns };
  }

  // ---- turn orchestration -------------------------------------------------

  private start(item: InternalQueued): void {
    this.running = this.runTurn(item).finally(() => this.afterTurn());
  }

  private afterTurn(): void {
    this.running = null;
    this.controller = null;
    // "Send now" messages the turn ended before reading go first in line.
    if (this.steering.length > 0) this.queue.unshift(...this.steering.splice(0));
    // A turn that was stopped, failed or stopped itself pauses a mission, whatever is queued behind it.
    const finished = this.lastTurn.end === 'completed';
    if (!finished) this.missionFollowUp();
    if (this.disposed || this.status === 'error') {
      this.emit({ type: 'queue', queue: this.publicQueue() });
      return;
    }
    // What the user sent meanwhile is answered first; the mission picks up after it.
    const next = this.queue.shift() ?? (finished ? this.missionFollowUp() : null);
    if (next) {
      this.emit({ type: 'queue', queue: this.publicQueue() });
      this.start(next);
    }
  }

  /** Waits for the current turn, and for any turn it hands off to (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running.catch(() => undefined);
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

  /** The sandbox this session's commands run in, when its project turned one on. */
  private sandboxTarget(): SandboxTarget | null {
    if (this.summary.kind !== 'code' || !this.deps.sandbox) return null;
    const workspace = this.projectRoot();
    const root = this.settingsRoot();
    const settings = workspace && root ? this.deps.sandbox(root) : null;
    return workspace && settings ? { workspace, settings } : null;
  }

  /** What the system prompt says about the sandbox the next turn runs in. */
  private sandboxPrompt(): { image: string; network: boolean; ports: number[] } | null {
    const target = this.sandboxTarget();
    return target ? { image: target.settings.image, network: target.settings.network, ports: FORWARDED_PORTS } : null;
  }

  /**
   * Points the session's shell at its sandbox, or back at this computer. Runs
   * before each turn and "!" command, so a change made in the meantime applies
   * to the next one. The system prompt says where commands run, so a change
   * rebuilds it.
   */
  private async syncSandbox(): Promise<void> {
    const target = this.sandboxTarget();
    const before = JSON.stringify(this.deps.shells.sandboxFor(this.id));
    await this.deps.shells.setSandbox(this.id, target);
    if (JSON.stringify(this.deps.shells.sandboxFor(this.id)) !== before) this.system = null;
  }

  /**
   * The project's checks, when it defines any. They run commands from the
   * repository, so — like hooks and allow rules — they need the project trusted.
   */
  private checksConfig(): ChecksConfig | null {
    if (this.summary.kind !== 'code') return null;
    const root = this.settingsRoot();
    return root ? this.deps.settings.checks(root, this.deps.isTrusted(root)) : null;
  }

  /** Runs the checks; null when the turn was stopped or they couldn't run. */
  private async runChecks(root: string | null, round: number, signal: AbortSignal): Promise<CheckReport | null> {
    const config = this.checksConfig();
    if (!config || !root) return null;
    this.emit({ type: 'checks', commands: config.commands, round });
    try {
      const report = await runChecks(config, round, {
        sessionId: this.id,
        cwd: this.workingDir(),
        signal,
        shells: this.deps.shells
      });
      if (signal.aborted) return null;
      this.deps.log('info', 'Checks finished', { session: this.id, passed: report.passed, round });
      return report;
    } catch (error) {
      this.notice('warning', `Couldn't run the project's checks: ${(error as Error).message}`);
      return null;
    }
  }

  /** Runs a prompt a connected MCP server publishes: the server fills it in and the result is sent as the user's message. */
  private async runMcpPrompt(command: string, args: string, typed: string): Promise<{ text: string; typed: string } | null> {
    const root = this.settingsRoot();
    const prompt = this.deps.mcpPrompts(root).find((p) => mcpPromptCommand(p.server, p.name) === command);
    if (!prompt) {
      this.commandOutput(`No MCP prompt is called /${command}. Type / to see the prompts your connected servers offer.`);
      return null;
    }
    const values = promptArguments(args, prompt.arguments.map((a) => a.name));
    const missing = prompt.arguments.filter((a) => a.required && values[a.name] === undefined);
    if (missing.length > 0) {
      this.commandOutput(`/${command} needs ${missing.map((a) => `<${a.name}>`).join(', ')}. Usage: /${command} ${promptHint(prompt)}`);
      return null;
    }
    try {
      const filled = await this.deps.mcpPrompt(prompt.server, prompt.name, values, root);
      if (filled.text.length === 0) {
        this.commandOutput(`The ${prompt.server} server returned an empty prompt for /${command}.`);
        return null;
      }
      return { text: filled.text, typed };
    } catch (error) {
      this.commandOutput(`The ${prompt.server} server couldn't fill in /${command}: ${(error as Error).message}`);
      return null;
    }
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
    if (slash.name.startsWith('mcp__')) return this.runMcpPrompt(slash.name, slash.args, item.text);
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
        const lines = [
          ...listCommands(this.deps.graftHome, this.projectRoot()).map((c) => `- /${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''} — ${c.description}`),
          ...this.deps.mcpPrompts(this.settingsRoot()).map((p) => `- /${mcpPromptCommand(p.server, p.name)}${promptHint(p) ? ` ${promptHint(p)}` : ''} — ${p.description || `Prompt from the ${p.server} server`}`)
        ];
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
      case 'decompile':
        return { text: decompilePrompt(slash.args), typed: item.text };
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

  /**
   * Generated media for this session and model: the image engine behind
   * GenerateImage, and whether ComfyUI is connected. Incognito chats get
   * neither, so nothing they write goes to an image provider.
   */
  private mediaFor(model: ModelInfo): { image: string | null; comfy: boolean } {
    const media = this.deps.media;
    if (!media || !model.supportsTools || this.summary.incognito) return { image: null, comfy: false };
    const engine = media.imageEngine();
    return { image: engine ? (engine.engine === 'comfyui' ? 'ComfyUI on this computer' : engine.model) : null, comfy: media.comfy() !== null };
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
    const media = this.mediaFor(model);
    // Chats get the apps connected for all projects (never in incognito, which keeps everything local).
    const mcpTools = this.mcpToolsFor(model);
    const chatOnly = new Set<string>(CHAT_ONLY_TOOLS);
    const mission = summary.kind === 'code' ? this.deps.store.getMission(this.id) : null;
    const onMission = mission !== null && missionOpen(mission.status);
    const builtins =
      summary.kind === 'code'
        ? this.deps.tools
            .names()
            .filter(
              (n) =>
                !n.startsWith('mcp__') &&
                !chatOnly.has(n) &&
                (n !== 'WebSearch' || web.clientSearch) &&
                n !== 'ToolSearch' &&
                (n !== 'Computer' || computer) &&
                (n !== 'Browser' || this.deps.browser !== undefined) &&
                (n !== 'GenerateImage' || media.image !== null) &&
                (n !== 'ComfyUI' || media.comfy) &&
                (n !== 'MissionUpdate' || onMission)
            )
        : [
            ...(web.fetch ? ['WebFetch'] : []),
            ...(web.clientSearch ? ['WebSearch'] : []),
            ...(work.files ? ['CreateFile'] : []),
            ...(work.code ? ['RunCode'] : []),
            // A chat keeps what it makes in its own files, so pictures need those.
            ...(work.files && media.image !== null ? ['GenerateImage'] : [])
          ];
    const { offered } = this.splitMcp(mcpTools, model);
    return [...builtins, ...(this.mcpDeferred ? ['ToolSearch'] : []), ...offered];
  }

  /** The MCP tools this session can use: a code session's own and the user's, a chat's user-level ones, none in incognito. */
  private mcpToolsFor(model: ModelInfo): string[] {
    const summary = this.summary;
    return summary.kind === 'code' ? this.deps.mcpToolNames(this.settingsRoot()) : summary.incognito || !model.supportsTools ? [] : this.deps.mcpToolNames(null);
  }

  /**
   * MCP tools whose definitions would weigh on every request (a big setup: GitHub's
   * has dozens) are not sent until the agent searches for them with ToolSearch.
   * The choice is made once, so the tools and the prompt stay the same between turns.
   */
  private splitMcp(mcpTools: string[], model: ModelInfo): { offered: string[]; deferred: string[] } {
    if (mcpTools.length === 0) return { offered: [], deferred: [] };
    if (!this.mcpDeferred) {
      const weight = estimateTextTokens(JSON.stringify(this.deps.tools.specs(mcpTools)));
      if (weight > Math.min(DEFER_MCP_TOKENS, Math.floor(model.contextWindow * 0.1))) this.mcpDeferred = true;
    }
    if (!this.mcpDeferred) return { offered: mcpTools, deferred: [] };
    return { offered: mcpTools.filter((n) => this.loadedMcp.has(n)), deferred: mcpTools.filter((n) => !this.loadedMcp.has(n)) };
  }

  /** How many tools of each server are waiting, for the prompt. */
  private deferredByServer(model: ModelInfo): Array<{ server: string; count: number }> {
    const { deferred } = this.splitMcp(this.mcpToolsFor(model), model);
    const counts = new Map<string, number>();
    for (const name of deferred) {
      const server = this.deps.tools.get(name)?.mcp?.server ?? 'other';
      counts.set(server, (counts.get(server) ?? 0) + 1);
    }
    return [...counts].map(([server, count]) => ({ server, count }));
  }

  /** The tools waiting to be loaded, as ToolSearch searches them. */
  private deferredEntries(): SearchableTool[] {
    const summary = this.summary;
    const names = summary.kind === 'code' ? this.deps.mcpToolNames(this.settingsRoot()) : this.deps.mcpToolNames(null);
    return names
      .filter((n) => !this.loadedMcp.has(n))
      .flatMap((name) => {
        const tool = this.deps.tools.get(name);
        return tool ? [{ name, server: tool.mcp?.server ?? '', description: tool.description }] : [];
      });
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
        mcpNotes: this.deps.mcpInstructions(this.settingsRoot()),
        deferredTools: this.deferredByServer(model),
        agents: loadAgents(this.deps.graftHome, root).map(({ name, description }) => ({ name, description })),
        personalization: prefs.personalization,
        sandbox: this.sandboxPrompt(),
        site: (await this.deps.site?.(root)) ?? null,
        media: this.mediaFor(model)
      });
    }
    // An incognito chat doesn't tell the provider who is asking or what they wrote about themselves.
    return buildChatSystemPrompt({
      date: this.deps.now().toISOString().slice(0, 10),
      name: summary.incognito ? null : prefs.userName,
      model: identity,
      web: { search: web.native || web.clientSearch, fetch: web.fetch },
      workspace: this.chatWork(model),
      personalization: summary.incognito ? null : prefs.personalization,
      mcpServers: summary.incognito ? [] : this.deps.mcpServerNames(null),
      mcpNotes: summary.incognito ? [] : this.deps.mcpInstructions(null),
      deferredTools: this.deferredByServer(model),
      images: this.chatWork(model).files ? this.mediaFor(model).image : null
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
    let endReason: TurnEnd = 'completed';
    let failure: string | null = null;
    try {
      const summary = this.summary;
      const root = this.projectRoot();
      const settingsRoot = this.settingsRoot();
      const trusted = settingsRoot ? this.deps.isTrusted(settingsRoot) : false;
      const hooks = summary.kind === 'code' ? this.deps.hooks(settingsRoot, trusted) : null;

      let userText: string | null = null;
      let starting: Mission | null = null;
      const missionTurn = item?.mission;
      if (missionTurn && missionTurn.kind !== 'start') {
        // A turn of a mission after its first: the mission restated, or its checks first when the agent reported it done.
        const step = missionTurn.kind === 'verify' ? await this.verifyMission(turnId, signal) : missionTurn;
        if (step === null) {
          if (signal.aborted) endReason = 'interrupted';
          return;
        }
        const stored = this.deps.store.appendMessage(this.id, 'user', [{ type: 'text', text: step.text }], {
          turnId,
          kind: 'mission',
          mission: { turn: step.turn, of: step.of, afterChecks: missionTurn.kind === 'verify' }
        });
        this.emit({ type: 'message', message: stored });
      } else if (item) {
        if (missionTurn) starting = createMission(this.id, missionTurn.input, randomUUID(), Date.now());
        const handled = starting ? { text: missionBrief(starting), typed: starting.objective } : await this.handleSlash(item);
        if (!handled) return;
        userText = handled.text;
        // A session that starts in Taproot (or reopens in it) gets the briefing with its first message.
        if ((summary.effort ?? this.deps.preferences().defaultEffort) === 'taproot') this.briefTaproot();
        if (!(await this.promptAllowed(hooks, userText, signal))) return;
        const userMessageId = randomUUID();
        let checkpointId: string | null = null;
        if (summary.kind === 'code') {
          try {
            checkpointId = await this.deps.checkpoint(this.id, this.workingDir(), userMessageId);
          } catch (error) {
            this.notice('warning', `Couldn't create a checkpoint before this turn: ${(error as Error).message}`);
          }
        }
        const content = this.userContent(item, userText);
        // The transcript shows what was typed; notes and attachments travel only to the model.
        const meta: MessageMeta = {
          turnId,
          typed: handled.typed ?? item.text,
          ...(item.files.length > 0 ? { attachments: item.files.map((f) => f.name) } : {}),
          ...(checkpointId ? { checkpointId } : {})
        };
        const stored = this.deps.store.appendMessage(this.id, 'user', content, meta, userMessageId);
        this.emit({ type: 'message', message: stored });
        // The mission starts with its message (and no earlier), so a rewind of that message takes the mission with it.
        if (starting) this.saveMission({ ...starting, createdAt: stored.createdAt, updatedAt: stored.createdAt });
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
      // Before the prompt: it says whether commands run in the sandbox.
      if (summary.kind === 'code') await this.syncSandbox();
      const { system, toolNames } = await this.ensurePrompt(model);
      const effort = this.effortFor(model);
      const host: LoopHost = {
        ...this.makeHost(model, provider, hooks, root, trusted),
        takeSteering: (s) => this.deliverSteering(turnId, hooks, s),
        checks: this.checksConfig() ? (round, s) => this.runChecks(root, round, s) : undefined
      };
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
          // No step cap unless Settings sets one: a long task runs until it's done (the repeat guard still stops loops).
          maxIterations: this.deps.preferences().maxSteps,
          agentLabel: null,
          ...(this.deps.retryPolicy ? { retryPolicy: this.deps.retryPolicy } : {}),
          taproot: effort === 'taproot',
          checksFix: this.checksConfig()?.fix ?? false,
          stripThinking: false,
          sessionId: this.id
        },
        host,
        signal
      );
      endReason = result.reason;
      if (result.reason === 'error' && result.error) {
        failure = result.error.message;
        this.setStatus('error', result.error);
        this.deps.notify(this.summary, 'error', result.error.message);
        return;
      }
      if (result.reason === 'completed' && userText !== null) this.maybeTitle(starting ? starting.objective : userText);
      // A turn of a mission that is still going isn't the end of anything: the mission says when it is done or needs the user.
      const onMission = this.deps.store.getMission(this.id)?.status === 'active';
      if ((result.reason === 'completed' || result.reason === 'guard') && !onMission) this.deps.notify(this.summary, 'finished', result.finalText.slice(0, 140));
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
      failure = info.message;
      this.deps.log('error', 'Turn failed', { session: this.id, message: info.message });
      this.setStatus('error', info);
      this.deps.notify(this.summary, 'error', info.message);
    } finally {
      this.lastTurn = { end: endReason, error: failure };
      if (this.status !== 'error') this.setStatus('idle');
      this.emit({ type: 'turn-end', turnId, reason: endReason });
    }
  }

  /** Runs the UserPromptSubmit hook: false when it blocks the message; context it returns joins the notes. */
  private async promptAllowed(hooks: HookRunner | null, text: string, signal: AbortSignal): Promise<boolean> {
    if (!hooks?.has('UserPromptSubmit')) return true;
    const verdict = await hooks.run('UserPromptSubmit', { session_id: this.id, prompt: text }, signal);
    for (const e of verdict.errors) this.notice('warning', e);
    if (verdict.decision === 'block') {
      this.notice('error', `Your message was blocked by a UserPromptSubmit hook: ${verdict.reason ?? 'no reason given'}`);
      return false;
    }
    if (verdict.context) this.notes.push(verdict.context);
    return true;
  }

  /** What the model gets for a typed message: pending notes, images, the text, attached files and @-mentioned files. */
  private userContent(item: InternalQueued, text: string): ContentBlock[] {
    const root = this.projectRoot();
    const content: ContentBlock[] = [...this.notes.map((note) => ({ type: 'text' as const, text: note })), ...item.images];
    if (text.length > 0) content.push({ type: 'text', text });
    for (const file of item.files) {
      content.push({ type: 'text', text: `<attached-file name="${file.name.replace(/"/g, "'")}">\n${file.content}\n</attached-file>` });
    }
    if (this.summary.kind === 'code' && root && text.includes('@')) {
      const mentions = expandMentions(text, this.workingDir(), root, this.deps.platform);
      for (const block of mentions.blocks) content.push({ type: 'text', text: block });
      for (const file of mentions.files) this.files.record(file);
    }
    this.notes = [];
    return content;
  }

  /**
   * Delivers messages sent with "Send now": each is stored as a user message
   * after the latest tool results and returned for the running loop's history.
   */
  private async deliverSteering(turnId: string, hooks: HookRunner | null, signal: AbortSignal): Promise<ContentBlock[][]> {
    const items = this.steering.splice(0);
    if (items.length === 0) return [];
    this.emit({ type: 'queue', queue: this.publicQueue() });
    const delivered: ContentBlock[][] = [];
    for (const item of items) {
      if (!(await this.promptAllowed(hooks, item.text, signal))) continue;
      const content = this.userContent(item, item.text);
      const meta: MessageMeta = { turnId, typed: item.text, ...(item.files.length > 0 ? { attachments: item.files.map((f) => f.name) } : {}) };
      const stored = this.deps.store.appendMessage(this.id, 'user', content, meta);
      this.emit({ type: 'message', message: stored });
      delivered.push(content);
    }
    return delivered;
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
      allowNetwork: this.summary.kind === 'chat',
      sandboxed: this.deps.shells.sandboxFor(this.id) !== null
    };
  }

  /**
   * Asks the user about one action. Agents working side by side can each need
   * an answer at the same moment, and there is one card: requests wait their turn.
   */
  private prompt(request: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer> {
    const asked = this.promptChain.then(() => this.promptNow(request, signal));
    this.promptChain = asked.catch(() => undefined);
    return asked;
  }

  private promptNow(request: PermissionRequest, signal: AbortSignal): Promise<PermissionAnswer> {
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
      maybeCompact: async (_history, tokens, signal, overflow) => {
        if (!this.deps.preferences().autoCompact || !(overflow || shouldCompact(tokens, model.contextWindow))) return null;
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

  /**
   * The Browser panel for this session's Browser tool. In a sandboxed session,
   * localhost addresses go to the port the sandbox forwards, so a dev server the
   * agent started in the container opens like one running on this computer.
   */
  private agentBrowser(): AgentBrowser | null {
    if (!this.deps.browser) return null;
    const panel = (): BrowserPanel => {
      const p = this.deps.browser?.();
      if (!p) throw new Error('The browser needs the Graft window open.');
      return p;
    };
    return {
      open: async (url) => {
        const p = panel();
        this.deps.revealBrowser?.(this.id);
        const opened = await p.navigate(sandboxUrl(url, this.deps.shells.sandbox?.box(this.id)?.ports ?? {}));
        await p.settle();
        return opened;
      },
      snapshot: () => panel().snapshot(),
      capture: () => panel().capture(),
      click: (target) => panel().click(target),
      type: (target, text, submit) => panel().type(target, text, submit),
      press: (key) => panel().press(key),
      scroll: (direction) => panel().scroll(direction),
      back: async () => {
        const p = panel();
        p.back();
        await p.settle();
      },
      reload: async () => {
        const p = panel();
        p.reload();
        await p.settle();
      },
      waitForText: (text, ms) => panel().waitForText(text, ms),
      console: () => this.deps.browser?.()?.consoleLog() ?? [],
      currentUrl: () => this.deps.browser?.()?.currentUrl() ?? null
    };
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
      mcpRoot: this.summary.kind === 'code' ? this.settingsRoot() : null,
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
      runAgents: (input) => this.runAgents(input, toolUseId, signal, model, provider, hooks, root, trusted),
      notesForPaths: (paths) => this.memory?.notesFor(paths) ?? null,
      search: (query, count, searchSignal) => this.deps.search.search(query, count, searchSignal),
      computer: this.deps.computer,
      chatFiles: work.files && this.deps.chatFiles ? { save: (name, data) => this.deps.chatFiles!.save(this.id, name, data) } : null,
      makeDocument:
        work.files && this.deps.documents
          ? (kind, name, source, s) =>
              this.deps.documents!.make(
                kind,
                source,
                // A document may place the pictures made in its own chat, and nothing else.
                { title: name.replace(/\.[^.]+$/, ''), assets: { image: (file) => this.deps.chatFiles?.image?.(this.id, file) ?? null } },
                s
              )
          : null,
      runCode: work.code ? this.deps.runCode : null,
      browser: this.summary.kind === 'code' ? this.agentBrowser() : null,
      media: this.summary.incognito ? null : this.deps.media,
      mission: this.summary.kind === 'code' ? { update: (input) => this.updateMission(input) } : null,
      spend: (costUsd) => {
        const current = this.summary.usage;
        const next = { ...current, costUsd: (current.costUsd ?? 0) + costUsd };
        this.deps.store.updateSession(this.id, { usage: next });
        this.emit({ type: 'usage', usage: next });
      },
      deferredTools: this.mcpDeferred
        ? {
            find: (query, limit) => searchTools(this.deferredEntries(), query, limit),
            load: (names) => {
              for (const name of names) {
                this.loadedMcp.add(name);
                // The running turn offers them from its next request on.
                if (this.toolNames && !this.toolNames.includes(name)) this.toolNames.push(name);
              }
            },
            summary: () => {
              const waiting = this.deferredByServer(model);
              return waiting.length > 0 ? `Waiting to be loaded: ${waiting.map((w) => `${w.server} (${String(w.count)})`).join(', ')}.` : 'Nothing is waiting to be loaded.';
            }
          }
        : null
    };
  }

  /** Stops one agent of a group that is running (the Agents panel's Stop); the rest of the group goes on. False when it already ended. */
  stopAgent(runId: string): boolean {
    const run = this.deps.store.listAgentRuns(this.id).find((r) => r.id === runId);
    return run ? (this.agentGroups.get(run.groupId)?.stop(run.nodeId) ?? false) : false;
  }

  /** Runs a group of agents for the RunAgents tool; each agent's record is saved with the session and shown in the agent graph. */
  private async runAgents(
    input: AgentGroupInput,
    parentToolUseId: string,
    signal: AbortSignal,
    model: ModelInfo,
    provider: LLMProvider,
    hooks: HookRunner | null,
    root: string | null,
    trusted: boolean
  ): Promise<{ report: string; agents: Array<{ nodeId: string; title: string; role: string; status: string; durationMs: number | null }> }> {
    const prefs = this.deps.preferences();
    const { report, runs } = await runAgentGroup(
      input,
      parentToolUseId,
      {
        onControl: (control) => this.agentGroups.set(parentToolUseId, control),
        sessionId: this.id,
        system: this.system ?? '',
        toolNames: this.toolNames ?? this.deps.tools.names(),
        customAgents: loadAgents(this.deps.graftHome, this.projectRoot()),
        sessionModel: model,
        sessionProvider: provider,
        settings: prefs.agents,
        registry: this.deps.tools,
        privacy: this.privacy(),
        maxSteps: prefs.maxSteps ?? SUBAGENT_ITERATIONS,
        ...(this.deps.retryPolicy ? { retryPolicy: this.deps.retryPolicy } : {}),
        candidates: async (s) => (await this.deps.models.candidates?.(s)) ?? [model],
        resolve: (ref, s) => this.deps.models.resolve(ref, s),
        loopHost: (m, p) => this.makeHost(m, p, hooks, root, trusted),
        // Taproot is the main agent's way of working; an agent of a group gets the strongest plain effort instead.
        effort: (m) => {
          const effort = this.effortFor(m);
          return effort === 'taproot' ? (m.effort?.levels.includes('max') ? 'max' : (m.effort?.default ?? null)) : effort;
        },
        save: (run) => {
          this.deps.store.saveAgentRun(run);
          this.emit({ type: 'agent-run', run });
        },
        progress: (text) => this.emit({ type: 'tool-progress', toolUseId: parentToolUseId, chunk: text }),
        notice: (event) => this.emit(event)
      },
      signal
    ).finally(() => this.agentGroups.delete(parentToolUseId));
    return {
      report,
      agents: runs.map((run) => ({
        nodeId: run.nodeId,
        title: run.title,
        role: run.roleLabel,
        status: run.status,
        durationMs: run.startedAt !== null && run.endedAt !== null ? run.endedAt - run.startedAt : null
      }))
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
    const builtin = (BUILTIN_AGENTS as readonly string[]).includes(input.type);
    const agent = builtin ? null : (loadAgents(this.deps.graftHome, this.projectRoot()).find((a) => a.name === input.type) ?? null);
    if (!builtin && !agent) {
      const custom = loadAgents(this.deps.graftHome, this.projectRoot()).map((a) => a.name);
      throw new GraftError('unknown_agent', `There is no agent named "${input.type}". Use ${[...BUILTIN_AGENTS, ...custom].map((n) => `"${n}"`).join(', ')}.`);
    }
    // A sub-agent never gets more than the session has (e.g. no WebSearch without a search engine).
    const toolNames = subagentTools(this.toolNames ?? this.deps.tools.names(), READ_ONLY_TOOLS, PARENT_ONLY_TOOLS, input.type, agent);
    const readOnly = toolNames.every((n) => (READ_ONLY_TOOLS as readonly string[]).includes(n));
    const role = agent ? `\n\n# Your role: ${agent.name}\n${agent.instructions}` : '';
    const system = `${this.system ?? ''}\n\n# Delegated task\nYou are a sub-agent working on one task for the main agent: "${input.description}". You have a fresh context; the main agent sees only your final message, so make it a complete, self-contained report (findings with path:line references, changes made, anything unresolved).${readOnly ? ' You are read-only: research and report; do not try to change anything.' : ''}${role}`;
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
      // "Send now" messages are for the main agent; a sub-agent never takes them.
      takeSteering: () => Promise.resolve([]),
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
        maxIterations: this.deps.preferences().maxSteps ?? SUBAGENT_ITERATIONS,
        agentLabel: input.description,
        taproot: false,
        // The main turn runs the project's checks; a sub-agent's work is one task
        // inside that turn and is covered by the same run.
        checksFix: false,
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

