import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '@shared/schemas/agentEvents';
import { addUsage, EMPTY_USAGE, type EffortLevel, type Usage } from '@shared/schemas/common';
import type { LlmMessage, StoredMessage } from '@shared/schemas/messages';
import type { ModelInfo } from '@shared/schemas/models';
import type { Source } from '@shared/sources';
import type { PermissionRequest, PermissionResponse, QuestionAnswer, QuestionRequest, QuestionResponse } from '@shared/schemas/permissions';
import type { SessionStatus, SessionSummary } from '@shared/schemas/sessions';
import type { TodoItem } from '@shared/schemas/toolDisplay';
import { GraftError } from '@shared/errors';
import { MEDIA_USAGE, usageDay } from '@shared/usage';
import { sandboxUrl } from '../sandbox/sandbox';
import type { BrowserPanel } from '../browser/browserPanel';
import type { LLMProvider, RequestPrivacy } from '../providers/types';
import { decide, type Decision } from '../permissions/engine';
import type { FileStateTracker } from '../tools/fileState';
import type { AgentBrowser, SubagentType, ToolContext } from '../tools/types';
import { PARENT_ONLY_TOOLS, READ_ONLY_TOOLS } from '../tools/builtin';
import { BUILTIN_AGENTS, loadAgents, subagentTools } from './agents';
import { runAgentGroup, type AgentGroupInput } from './agentGroup';
import type { HookRunner } from './hooks';
import { runAgentLoop, type LoopHost, type LoopModel, type PermissionAnswer, type PermissionPrompt } from './loop';
import type { MissionController } from './missionController';
import type { GraphControl } from './orchestrator';
import { workspaceHost } from './workspaceHost';
import type { SessionDeps } from './session';
import { shouldCompact } from './tokens';
import { TurnBudget } from './turnBudget';

/** A sub-agent's steps when Settings sets no limit: it reports back on one delegated task, so it stays bounded. */
const SUBAGENT_ITERATIONS = 200;

/** Where a turn runs and what it may trust: the same for the turn and for every agent it starts. */
export interface TurnScope {
  hooks: HookRunner | null;
  root: string | null;
  trusted: boolean;
}

/** The model a loop is answered by. It changes when the backup model takes over (see loopHost). */
export interface Answering {
  model: ModelInfo;
  provider: LLMProvider;
}

/** What a loop asks of the model that would take over from its own. */
export interface BackupNeeds {
  /** The loop offers tools, so the backup has to be able to call them. */
  tools: boolean;
  /** The loop's work is looking at pictures (a UI reviewer). */
  vision: boolean;
  /** A sub-agent or an agent of a group: it never works in Taproot. */
  agent: boolean;
}

/** What the host needs from the session it belongs to. */
export interface HostPorts {
  id: string;
  deps: SessionDeps;
  files: FileStateTracker;
  missions: MissionController;
  summary(): SessionSummary;
  emit(event: AgentEvent): void;
  setStatus(status: SessionStatus): void;
  notice(level: 'info' | 'warning' | 'error', text: string): void;
  projectRoot(): string | null;
  settingsRoot(): string | null;
  workingDir(): string;
  /** CreateFile and RunCode, for chats with a model that uses tools. */
  chatWork(model: ModelInfo): { files: boolean; code: boolean };
  effortFor(model: ModelInfo): EffortLevel | null;
  privacy(): RequestPrivacy;
  /** The prompt and the tools of the running turn; null before the session's first. */
  system(): string | null;
  toolNames(): string[] | null;
  notesForPaths: ToolContext['notesForPaths'];
  /** The MCP tools waiting to be loaded with ToolSearch; null when the session sends them all. */
  deferredTools(model: ModelInfo): ToolContext['deferredTools'];
  /** The conversation as it is sent, and the two ways of making room in it. */
  history(): LlmMessage[];
  pruneOutput(tokens: number, contextWindow: number): boolean;
  compact(instructions: string, signal: AbortSignal, keepRecent: boolean, using: Answering): Promise<LlmMessage[] | null>;
  /** An approved plan ends Plan mode: the session goes back to the mode it was in before. */
  leavePlanMode(): void;
}

/**
 * What a session's agent loops get from their surroundings: answers from the user
 * (permissions, questions, plans), the context each tool runs in, the session's usage,
 * and the agents a turn starts (a sub-agent, a group). One per session; it holds what is
 * being asked right now and the rules allowed for the session.
 */
export class SessionHost {
  private pendingPermission: { request: PermissionRequest; resolve: (a: PermissionAnswer) => void } | null = null;
  private pendingQuestion: { request: QuestionRequest; resolve: (a: QuestionAnswer[] | null) => void } | null = null;
  private readonly sessionAllow: string[] = [];
  /** The groups of agents running now, by the RunAgents call that started each: how one agent of a group is stopped. */
  private readonly agentGroups = new Map<string, GraphControl>();
  /** The permission request on screen and those behind it (see prompt). */
  private promptChain: Promise<unknown> = Promise.resolve();
  /** What the running turn has used against the limits from Settings; null when none is set. */
  private turn: TurnBudget | null = null;

  constructor(private readonly ports: HostPorts) {}

  private get id(): string {
    return this.ports.id;
  }

  private get deps(): SessionDeps {
    return this.ports.deps;
  }

  private get summary(): SessionSummary {
    return this.ports.summary();
  }

  private emit(event: AgentEvent): void {
    this.ports.emit(event);
  }

  /**
   * Starts counting for a new turn. Every loop the turn starts reports its usage here, so the
   * limits hold for the whole of the work: the main agent, its sub-agents and its groups.
   */
  beginTurn(): void {
    const limits = this.deps.preferences().turnBudget;
    this.turn = limits.tokens !== null || limits.costUsd !== null || limits.minutes !== null ? new TurnBudget(limits, () => this.deps.now().getTime()) : null;
  }

  // ---- what the user is being asked ----------------------------------------

  /** The request and the question on screen, for a view that opens while they wait. */
  pending(): { permission: PermissionRequest | null; question: QuestionRequest | null } {
    return { permission: this.pendingPermission?.request ?? null, question: this.pendingQuestion?.request ?? null };
  }

  /**
   * Stop answers whatever the turn is waiting on. The matching *-resolved events
   * matter: without them the prompt card stays on screen with no way to answer it,
   * because the request it refers to is already gone.
   */
  cancelPending(): void {
    this.turn?.waiting(false);
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
      const root = this.ports.settingsRoot();
      if (root) {
        this.deps.trust(root);
        this.deps.settings.addRule('local', root, 'allow', rule).catch((error: unknown) => {
          this.ports.notice('warning', `Couldn't save the rule ${rule}: ${(error as Error).message}`);
        });
      }
    }
    this.emit({ type: 'permission-resolved', requestId: response.requestId });
    this.ports.setStatus('running');
    this.turn?.waiting(false);
    pending.resolve({
      decision: response.decision,
      ...(response.feedback ? { feedback: response.feedback } : {}),
      ...(response.plan !== undefined ? { plan: response.plan } : {})
    });
  }

  answerQuestion(response: QuestionResponse): void {
    const pending = this.pendingQuestion;
    if (!pending || pending.request.id !== response.requestId) {
      throw new GraftError('stale_request', 'That question is no longer pending.');
    }
    this.pendingQuestion = null;
    this.emit({ type: 'question-resolved', requestId: response.requestId });
    this.ports.setStatus('running');
    this.turn?.waiting(false);
    pending.resolve(response.dismissed ? null : response.answers);
  }

  private permissionEnv(scope: TurnScope) {
    const { rules, problems } = this.deps.settings.rules(this.ports.settingsRoot(), scope.trusted, this.sessionAllow);
    for (const p of problems) this.deps.log('warn', 'Settings problem', { message: p });
    return {
      mode: this.summary.permissionMode,
      projectRoot: scope.root ?? this.ports.workingDir(),
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
      this.ports.setStatus('needs-input');
      // The time the user takes to answer is theirs, not the turn's.
      this.turn?.waiting(true);
      this.emit({ type: 'permission', request });
      this.deps.notify(this.summary, 'needs-input', request.title);
    });
  }

  // ---- the loop host --------------------------------------------------------

  /**
   * The model from Settings → Models that finishes a loop when its own model keeps failing.
   * None in an incognito chat (its model was chosen for where it runs), none when it is the model
   * that is failing or can't be found, and none when it can't do what the loop needs of it.
   */
  private async backupFor(failing: ModelInfo, needs: BackupNeeds, signal: AbortSignal): Promise<LoopModel | null> {
    const ref = this.deps.preferences().fallbackModel;
    if (!ref || this.summary.incognito) return null;
    if (ref.providerId === failing.ref.providerId && ref.modelId === failing.ref.modelId) return null;
    try {
      const { provider, model } = await this.deps.models.resolve(ref, signal);
      if (needs.tools && !model.supportsTools) return null;
      if (needs.vision && !model.supportsVision) return null;
      return { provider, model, effort: needs.agent ? this.agentEffort(model) : this.ports.effortFor(model) };
    } catch (error) {
      this.deps.log('warn', 'The backup model is not available', { session: this.id, message: (error as Error).message });
      return null;
    }
  }

  /** Adds a request, or what a tool paid for, to the day it happened on (Settings → Usage). */
  private countForToday(ref: { providerId: string; modelId: string }, usage: Usage, costUsd: number | null): void {
    try {
      this.deps.store.recordUsage({ day: usageDay(this.deps.now()), providerId: ref.providerId, modelId: ref.modelId, usage, costUsd });
    } catch (error) {
      // The day's totals are a record beside the work, never a reason to fail it.
      this.deps.log('warn', "Couldn't record the day's usage", { session: this.id, message: (error as Error).message });
    }
  }

  /**
   * What a loop needs from the session. `answering` is the model the host measures, summarizes
   * and counts usage with: each loop passes its own, and it becomes the backup model when that
   * takes over, which `needs` decides.
   */
  loopHost(scope: TurnScope, answering: Answering, needs: BackupNeeds): LoopHost {
    const cwd = this.ports.workingDir();
    const describeContext = { cwd, projectRoot: scope.root ?? cwd, platform: this.deps.platform };
    return {
      append: (role, content, meta, id) => this.deps.store.appendMessage(this.id, role, content, meta, id),
      emit: (event) => this.emit(event),
      decide: (query) => decide(query, this.permissionEnv(scope)),
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
      toolContext: (toolUseId, signal) => this.toolContext(toolUseId, signal, answering, scope),
      describeContext: () => describeContext,
      hooks: scope.hooks,
      todos: () => this.deps.store.getTodos(this.id),
      maybeCompact: async (_history, tokens, signal, overflow) => {
        const window = answering.model.contextWindow;
        if (!this.deps.preferences().autoCompact || !(overflow || shouldCompact(tokens, window))) return null;
        // A request the provider just refused was measured wrong, so an estimate of what removing output frees can't be trusted either.
        if (!overflow && this.ports.pruneOutput(tokens, window)) return this.ports.history();
        // And one that was refused needs all the room there is: nothing is kept beside the summary.
        return this.ports.compact('', signal, !overflow, answering);
      },
      onUsage: (usage: Usage, contextTokens: number | null, costUsd: number | null) => {
        const current = this.summary.usage;
        const next = {
          totals: addUsage(current.totals, usage),
          contextTokens: contextTokens ?? current.contextTokens,
          contextLimit: contextTokens === null ? current.contextLimit : answering.model.contextWindow,
          costUsd: costUsd === null ? current.costUsd : (current.costUsd ?? 0) + costUsd
        };
        this.deps.store.updateSession(this.id, { usage: next });
        this.emit({ type: 'usage', usage: next });
        this.countForToday(answering.model.ref, usage, costUsd);
        const unfollowed = this.turn?.add(usage, costUsd, answering.model.label) ?? null;
        if (unfollowed) this.ports.notice('warning', unfollowed);
      },
      overBudget: () => this.turn?.exceeded() ?? null,
      fallback: async (_error, signal) => {
        const backup = await this.backupFor(answering.model, needs, signal);
        // From here the loop is measured against the backup, its tools know that model, and what it uses is the backup's.
        if (backup) Object.assign(answering, { model: backup.model, provider: backup.provider });
        return backup;
      },
      log: (level, message, fields) => this.deps.log(level, message, { session: this.id, ...fields })
    };
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

  private toolContext(toolUseId: string, signal: AbortSignal, answering: Answering, scope: TurnScope): ToolContext {
    const { model, provider } = answering;
    const cwd = this.ports.workingDir();
    const work = this.ports.chatWork(model);
    return {
      sessionId: this.id,
      toolUseId,
      mcpRoot: this.summary.kind === 'code' ? this.ports.settingsRoot() : null,
      trustedProject: scope.trusted && this.summary.kind === 'code',
      cwd,
      projectRoot: scope.root ?? cwd,
      platform: this.deps.platform,
      signal,
      files: this.ports.files,
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
          this.ports.setStatus('needs-input');
          this.turn?.waiting(true);
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
        if (answer.decision === 'deny') return { approved: false, feedback: answer.feedback ?? null, plan };
        this.ports.leavePlanMode();
        // The user may have edited the plan before approving it: theirs is the one to follow.
        // An edit that changed only spacing, or left nothing, is an ordinary approval.
        const edited = answer.plan?.trim() ?? '';
        return { approved: true, feedback: null, plan: edited.length > 0 && edited !== plan.trim() ? edited : plan };
      },
      runSubagent: (input) => this.runSubagent(input, toolUseId, signal, model, provider, scope),
      runAgents: (input) => this.runAgents(input, toolUseId, signal, model, provider, scope),
      notesForPaths: (paths) => this.ports.notesForPaths(paths),
      search: (query, count, searchSignal) => this.deps.search.search(query, count, searchSignal),
      computer: this.deps.computer,
      publicWebOnly: this.summary.kind === 'chat',
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
      mission: this.summary.kind === 'code' ? { update: (input) => this.ports.missions.update(input) } : null,
      spend: (costUsd) => {
        const current = this.summary.usage;
        const next = { ...current, costUsd: (current.costUsd ?? 0) + costUsd };
        this.deps.store.updateSession(this.id, { usage: next });
        this.emit({ type: 'usage', usage: next });
        this.countForToday(MEDIA_USAGE, EMPTY_USAGE, costUsd);
        this.turn?.spend(costUsd);
      },
      deferredTools: this.ports.deferredTools(model)
    };
  }

  // ---- the agents a turn starts ---------------------------------------------

  /** Stops one agent of a group that is running (the Agents panel's Stop); the rest of the group goes on. False when it already ended. */
  stopAgent(runId: string): boolean {
    const run = this.deps.store.listAgentRuns(this.id).find((r) => r.id === runId);
    return run ? (this.agentGroups.get(run.groupId)?.stop(run.nodeId) ?? false) : false;
  }

  /** An agent of a group or a sub-agent never thinks in Taproot, the main agent's way of working: it gets the strongest plain effort instead. */
  private agentEffort(model: ModelInfo): EffortLevel | null {
    const effort = this.ports.effortFor(model);
    return effort === 'taproot' ? (model.effort?.levels.includes('max') ? 'max' : (model.effort?.default ?? null)) : effort;
  }

  /** Runs a group of agents for the RunAgents tool; each agent's record is saved with the session and shown in the agent graph. */
  private async runAgents(
    input: AgentGroupInput,
    parentToolUseId: string,
    signal: AbortSignal,
    model: ModelInfo,
    provider: LLMProvider,
    scope: TurnScope
  ): Promise<{ report: string; agents: Array<{ nodeId: string; title: string; role: string; status: string; durationMs: number | null }>; sources: Source[] }> {
    const prefs = this.deps.preferences();
    const chat = this.summary.kind === 'chat';
    // A chat has no project: nothing to run a command in and no files to change. Its agents research, whatever role they are given.
    if (chat && input.agents.some((agent) => agent.verify !== undefined || agent.writes !== undefined)) {
      throw new GraftError('bad_agent_graph', 'In a chat, agents can search and read the web and nothing else: leave out verify and writes.');
    }
    const available = this.ports.toolNames() ?? this.deps.tools.names();
    const { report, runs, sources } = await runAgentGroup(
      input,
      parentToolUseId,
      {
        onControl: (control) => this.agentGroups.set(parentToolUseId, control),
        sessionId: this.id,
        system: this.ports.system() ?? '',
        toolNames: chat ? available.filter((name) => name === 'WebFetch' || name === 'WebSearch') : available,
        customAgents: loadAgents(this.deps.graftHome, this.ports.projectRoot()),
        sessionModel: model,
        sessionProvider: provider,
        settings: prefs.agents,
        registry: this.deps.tools,
        privacy: this.ports.privacy(),
        maxSteps: prefs.maxSteps ?? SUBAGENT_ITERATIONS,
        ...(this.deps.retryPolicy ? { retryPolicy: this.deps.retryPolicy } : {}),
        candidates: async (s) => (await this.deps.models.candidates?.(s)) ?? [model],
        resolve: (ref, s) => this.deps.models.resolve(ref, s),
        loopHost: (m, p, needsVision) => this.loopHost(scope, { model: m, provider: p }, { tools: true, vision: needsVision, agent: true }),
        ...(this.deps.workspaces ? { workspaces: this.deps.workspaces } : {}),
        effort: (m) => this.agentEffort(m),
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
      sources,
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
    scope: TurnScope
  ): Promise<{ text: string; toolCalls: number }> {
    const custom = loadAgents(this.deps.graftHome, this.ports.projectRoot());
    const builtin = (BUILTIN_AGENTS as readonly string[]).includes(input.type);
    const agent = builtin ? null : (custom.find((a) => a.name === input.type) ?? null);
    if (!builtin && !agent) {
      throw new GraftError('unknown_agent', `There is no agent named "${input.type}". Use ${[...BUILTIN_AGENTS, ...custom.map((a) => a.name)].map((n) => `"${n}"`).join(', ')}.`);
    }
    // A sub-agent never gets more than the session has (e.g. no WebSearch without a search engine).
    const toolNames = subagentTools(this.ports.toolNames() ?? this.deps.tools.names(), READ_ONLY_TOOLS, PARENT_ONLY_TOOLS, input.type, agent);
    const readOnly = toolNames.every((n) => (READ_ONLY_TOOLS as readonly string[]).includes(n));
    const role = agent ? `\n\n# Your role: ${agent.name}\n${agent.instructions}` : '';
    let system = `${this.ports.system() ?? ''}\n\n# Delegated task\nYou are a sub-agent working on one task for the main agent: "${input.description}". You have a fresh context; the main agent sees only your final message, so make it a complete, self-contained report (findings with path:line references, changes made, anything unresolved).${readOnly ? ' You are read-only: research and report; do not try to change anything.' : ''}${role}`;
    const scratch: StoredMessage[] = [];
    // Its own, so a backup model that takes over the sub-agent's task doesn't become the main agent's.
    const original = this.loopHost(scope, { model, provider }, { tools: true, vision: false, agent: true });
    // A sub-agent that writes works in a private checkout; what it changed is put back when it is done.
    const lease = this.deps.workspaces && !readOnly && this.summary.kind === 'code' ? await this.deps.workspaces.create(original.describeContext().cwd, signal) : null;
    let privateHost: Awaited<ReturnType<typeof workspaceHost>> | null;
    try {
      privateHost = lease ? await workspaceHost(original, lease) : null;
    } catch (error) {
      if (lease) this.deps.workspaces?.retain(lease);
      throw error;
    }
    if (lease) {
      system += `\n\n# Private writer checkout\nYour working directory is ${lease.cwd}. Use relative paths here. Ignored files and dependency folders are not copied. Destination conflicts preserve your checkout for review.`;
      this.ports.notice('info', 'The delegated writer is using a private checkout.');
    }
    const parent = privateHost?.host ?? original;
    const host: LoopHost = {
      ...parent,
      append: (messageRole, content, meta, id) => {
        const message: StoredMessage = { id: id ?? randomUUID(), sessionId: this.id, seq: scratch.length + 1, role: messageRole, content, meta, createdAt: Date.now() };
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
    try {
      const result = await runAgentLoop(
        [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
        {
          provider,
          model,
          registry: this.deps.tools,
          toolNames,
          system,
          effort: this.agentEffort(model),
          webSearch: false,
          cacheKey: `${this.id}:${parentToolUseId}`,
          privacy: this.ports.privacy(),
          turnId: parentToolUseId,
          maxIterations: this.deps.preferences().maxSteps ?? SUBAGENT_ITERATIONS,
          ...(this.deps.retryPolicy ? { retryPolicy: this.deps.retryPolicy } : {}),
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
      // Cut short by the turn's own limit: it did not finish, so its last words are not a report
      // and what it changed stays in its checkout (kept below) instead of going in half done.
      const over = result.reason === 'guard' ? (this.turn?.exceeded() ?? null) : null;
      if (over !== null) throw new GraftError('turn_limit', `Stopped: the turn reached a limit before this sub-agent finished. ${over}`);
      if (lease && this.deps.workspaces) {
        await privateHost?.close();
        const touched = scratch.flatMap((m) => m.content.flatMap((b) => (b.type === 'tool_result' && !b.isError && b.display?.kind === 'edit' ? [b.display.path] : [])));
        await this.deps.workspaces.integrate(lease, [], signal, touched);
        this.ports.files.clear();
      }
      return { text: result.finalText, toolCalls: result.toolCalls };
    } finally {
      await privateHost?.close();
      if (lease && lease.info.state !== 'integrated') {
        this.deps.workspaces?.retain(lease);
        this.ports.notice('warning', `The delegated writer's unfinished changes are retained at ${lease.cwd}.`);
      }
    }
  }
}
