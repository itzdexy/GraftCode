import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { addUsage, EMPTY_USAGE, type EffortLevel, type Usage } from '@shared/schemas/common';
import { textOf, type CheckReport, type ContentBlock, type LlmMessage, type MessageMeta, type StoredMessage, type ToolResultBlock, type ToolUseBlock } from '@shared/schemas/messages';
import type { ModelInfo, ProviderErrorCode } from '@shared/schemas/models';
import type { AgentEvent } from '@shared/schemas/agentEvents';
import type { PermissionDecision, PermissionDetail } from '@shared/schemas/permissions';
import { ProviderError, isAbortError } from '../providers/errors';
import { streamWithRetry, type RetryPolicy } from '../providers/retry';
import type { FinishReason, LLMProvider, RequestPrivacy, StreamRequest } from '../providers/types';
import type { TodoItem } from '@shared/schemas/toolDisplay';
import { classifyCommand } from '../permissions/commandRisk';
import type { Decision, PermissionQuery } from '../permissions/engine';
import type { ToolRegistry } from '../tools/registry';
import type { AnyTool, DescribeContext, ToolCallDescriptor, ToolContext, ToolResult } from '../tools/types';
import { checksFailurePrompt, checksSummary, MAX_CHECK_ROUNDS } from './checks';
import type { HookRunner } from './hooks';
import { withoutThinking } from './history';
import { toBatches } from './toolBatches';
import { TAPROOT_REVIEW, taprootOpenTasks } from './systemPrompt';
import { contextTokens, estimateMessagesTokens, estimateTextTokens, usageCost } from './tokens';

export interface PermissionPrompt {
  toolUseId: string;
  toolName: string;
  title: string;
  detail: PermissionDetail;
  decision: Decision;
  agentLabel: string | null;
}

export interface PermissionAnswer {
  decision: PermissionDecision;
  feedback?: string;
  /** The plan as the user edited it, when the request was the approval of a plan. */
  plan?: string;
}

/** How many times a Taproot turn is sent back to its open tasks before it may finish. */
const MAX_TODO_NUDGES = 3;

/** A model as the loop asks it: where it lives, what it is, and how hard it should think. */
export interface LoopModel {
  provider: LLMProvider;
  model: ModelInfo;
  effort: EffortLevel | null;
}

/**
 * Failures another model may not have, and what the notice calls them. The rest (a wrong
 * key, a request the provider rejects, a conversation that is too long) would follow the
 * turn to any model, or are the user's to fix.
 */
const FALLBACK_REASONS: Partial<Record<ProviderErrorCode, string>> = {
  overloaded: 'overloaded',
  rate_limit: 'rate limited',
  server: 'server error',
  network: 'unreachable'
};

/** Everything the loop needs from its surroundings (session, UI, storage). */
export interface LoopHost {
  append(role: 'user' | 'assistant', content: ContentBlock[], meta: MessageMeta, id?: string): StoredMessage;
  emit(event: AgentEvent): void;
  decide(query: PermissionQuery): Decision;
  askPermission(prompt: PermissionPrompt, signal: AbortSignal): Promise<PermissionAnswer>;
  toolContext(toolUseId: string, signal: AbortSignal): ToolContext;
  describeContext(): DescribeContext;
  hooks: HookRunner | null;
  /**
   * Called before each model request; returns a replacement history when it compacted.
   * `overflow` means the provider just refused the request as too long, so compact
   * whatever the estimate says.
   */
  maybeCompact(history: LlmMessage[], contextTokens: number, signal: AbortSignal, overflow?: boolean): Promise<LlmMessage[] | null>;
  /** `contextTokens` is null when the usage isn't from this conversation (a subagent's); `costUsd` null means unknown. */
  onUsage(usage: Usage, contextTokens: number | null, costUsd: number | null): void;
  /** The session's task list (Taproot won't finish with tasks open). */
  todos(): TodoItem[];
  /**
   * The project's own checks, run after a turn changed something. Absent when the
   * project defines none, or when it is not trusted (checks run its commands).
   * Returns the report to show, or null when the turn was interrupted.
   */
  checks?(round: number, signal: AbortSignal): Promise<CheckReport | null>;
  /**
   * Messages the user sent with "Send now" while the turn ran: stored as
   * user messages after the latest tool results and returned for the
   * history, so the agent reads them at its next step.
   */
  takeSteering?(signal: AbortSignal): Promise<ContentBlock[][]>;
  /**
   * Another model to finish the turn with, after `error` ended a request before any
   * output and after its retries; null when there is none. Asked at most once a turn.
   */
  fallback?(error: ProviderError): Promise<LoopModel | null>;
  log(level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, string | number | boolean>): void;
}

export interface LoopConfig {
  provider: LLMProvider;
  model: ModelInfo;
  registry: ToolRegistry;
  toolNames: string[];
  system: string;
  effort: EffortLevel | null;
  webSearch: boolean;
  cacheKey: string;
  privacy: RequestPrivacy;
  turnId: string;
  /** Model steps before the turn pauses; null runs until the work is done (the repeat guard still applies). */
  maxIterations: number | null;
  retryPolicy?: RetryPolicy;
  /** Label shown on permission prompts raised by a sub-agent. */
  agentLabel: string | null;
  /** Taproot: one forced verification pass before the turn may end. */
  taproot: boolean;
  /** Send a failed check back to the model to fix, instead of only reporting it. */
  checksFix: boolean;
  /** Drop replayed thinking (after a model or history change). */
  stripThinking: boolean;
  sessionId: string;
}

export interface LoopResult {
  reason: 'completed' | 'interrupted' | 'error' | 'guard';
  error: { code: string; message: string } | null;
  usage: Usage;
  toolCalls: number;
  finalText: string;
  /** The turn changed something (an edit, a write or a command): the project's checks should run. */
  changed: boolean;
}

interface Prepared {
  call: ToolUseBlock;
  tool: AnyTool | null;
  input: unknown;
  descriptor: ToolCallDescriptor | null;
  decision: Decision | null;
  error: string | null;
}

function zodMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 4)
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : 'input'}: ${i.message}`)
    .join('; ');
}

function errorBlock(toolUseId: string, message: string, denied = false): ToolResultBlock {
  return {
    type: 'tool_result',
    toolUseId,
    isError: true,
    content: [{ type: 'text', text: message }],
    display: denied ? { kind: 'denied', reason: message } : { kind: 'error', message }
  };
}

function resultBlock(toolUseId: string, result: ToolResult, extra: string[]): ToolResultBlock {
  return {
    type: 'tool_result',
    toolUseId,
    isError: result.isError,
    content: [...result.content, ...extra.map((text) => ({ type: 'text' as const, text }))],
    display: result.display
  };
}

async function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve('timeout');
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function prepareCall(call: ToolUseBlock, config: LoopConfig, host: LoopHost): Promise<Prepared> {
  const base: Prepared = { call, tool: null, input: undefined, descriptor: null, decision: null, error: null };
  const tool = config.toolNames.includes(call.name) ? (config.registry.get(call.name) ?? null) : null;
  if (!tool) return { ...base, error: `Unknown tool "${call.name}". Available tools: ${config.toolNames.join(', ')}.` };
  if (call.meta?.invalidJson === 'true') {
    return { ...base, tool, error: 'The tool input was not valid JSON (the response may have been cut off). Call the tool again with complete arguments.' };
  }
  const parsed = (tool.input as z.ZodType).safeParse(call.input);
  if (!parsed.success) return { ...base, tool, error: `Invalid input for ${tool.name}: ${zodMessage(parsed.error)}` };
  let descriptor: ToolCallDescriptor;
  try {
    descriptor = await tool.describe(parsed.data as never, host.describeContext());
  } catch (error) {
    return { ...base, tool, error: `Could not prepare ${tool.name}: ${(error as Error).message}` };
  }
  const decision = host.decide({
    toolName: tool.name,
    permissionClass: tool.permissionClass,
    descriptor,
    ...(tool.mcp ? { mcp: { readOnly: tool.mcp.readOnly, destructive: tool.mcp.destructive } } : {})
  });
  return { ...base, tool, input: parsed.data, descriptor, decision };
}

async function runCall(p: Prepared, config: LoopConfig, host: LoopHost, signal: AbortSignal): Promise<ToolResultBlock> {
  const { call } = p;
  if (p.error || !p.tool || !p.descriptor || !p.decision) return errorBlock(call.id, p.error ?? 'Tool call could not be prepared.');
  const tool = p.tool;
  let decision = p.decision;

  if (host.hooks?.has('PreToolUse')) {
    const verdict = await host.hooks.run('PreToolUse', { session_id: config.sessionId, tool_name: tool.name, tool_input: p.input }, signal, tool.name);
    for (const e of verdict.errors) host.emit({ type: 'notice', level: 'warning', text: e });
    if (verdict.decision === 'block') return errorBlock(call.id, `A PreToolUse hook blocked this call: ${verdict.reason ?? 'no reason given'}`, true);
    if (verdict.decision === 'approve' && decision.behavior === 'ask' && !decision.dangerous && !decision.outsideProject) {
      decision = { ...decision, behavior: 'allow', reason: 'Approved by a PreToolUse hook.' };
    }
  }
  if (decision.behavior === 'deny') return errorBlock(call.id, `Permission denied: ${decision.reason}`, true);
  if (decision.behavior === 'ask') {
    const answer = await host.askPermission(
      {
        toolUseId: call.id,
        toolName: tool.name,
        title: p.descriptor.summary,
        detail: p.descriptor.preview ?? { kind: 'generic', text: p.descriptor.summary },
        decision,
        agentLabel: config.agentLabel
      },
      signal
    );
    if (signal.aborted) return errorBlock(call.id, 'Not run: the turn was interrupted.');
    if (answer.decision === 'deny') {
      const feedback = answer.feedback?.trim();
      return errorBlock(call.id, `The user denied this action.${feedback ? ` Their feedback: ${feedback}` : ' Choose a different approach or ask what they want.'}`, true);
    }
  }

  host.emit({ type: 'tool-start', toolUseId: call.id, name: tool.name, summary: p.descriptor.summary });
  const controller = new AbortController();
  const forward = (): void => controller.abort();
  signal.addEventListener('abort', forward, { once: true });
  let result: ToolResult | 'timeout';
  try {
    result = await withTimeout(tool.execute(p.input as never, host.toolContext(call.id, controller.signal)), tool.timeoutMs, () => controller.abort());
  } catch (error) {
    signal.removeEventListener('abort', forward);
    if (signal.aborted || isAbortError(error)) return errorBlock(call.id, 'Interrupted by the user.');
    host.log('error', `Tool ${tool.name} failed`, { message: (error as Error).message });
    return errorBlock(call.id, `${tool.name} failed: ${(error as Error).message}`);
  }
  signal.removeEventListener('abort', forward);
  if (result === 'timeout') return errorBlock(call.id, `${tool.name} timed out after ${Math.round(tool.timeoutMs / 1000)}s and was stopped.`);

  const extra: string[] = [];
  if (host.hooks?.has('PostToolUse')) {
    const verdict = await host.hooks.run(
      'PostToolUse',
      { session_id: config.sessionId, tool_name: tool.name, tool_input: p.input, tool_response: textOf(result.content).slice(0, 20_000) },
      signal,
      tool.name
    );
    for (const e of verdict.errors) host.emit({ type: 'notice', level: 'warning', text: e });
    if (verdict.decision === 'block' && verdict.reason) extra.push(`PostToolUse hook feedback: ${verdict.reason}`);
    if (verdict.context) extra.push(verdict.context);
  }
  return resultBlock(call.id, result, extra);
}

/**
 * Runs one tool call the way a turn would: checked against the permission
 * rules, through the hooks, asking the user when it has to. For callers that
 * run a tool on the agent's behalf (an agent group's check command).
 */
export async function runToolCall(call: ToolUseBlock, config: LoopConfig, host: LoopHost, signal: AbortSignal): Promise<ToolResultBlock> {
  return runCall(await prepareCall(call, config, host), config, host, signal);
}

/** A call that can run beside its neighbours: refused before it starts, or safe to overlap and already approved. */
function overlaps(p: Prepared): boolean {
  if (p.error !== null || !p.tool) return true;
  return p.decision?.behavior === 'allow' && p.tool.concurrencySafe(p.input as never);
}

/**
 * Executes the tool calls of one response. Neighbouring calls that are safe to
 * overlap (reads, searches, anything already approved that changes nothing) run
 * together; every other call runs alone, in the order it was given, so a read
 * after an edit sees the edit. Results keep the order of the calls.
 */
async function executeCalls(calls: ToolUseBlock[], config: LoopConfig, host: LoopHost, signal: AbortSignal): Promise<ToolResultBlock[]> {
  const prepared = await Promise.all(calls.map((c) => prepareCall(c, config, host)));
  const results: ToolResultBlock[] = [];
  for (const batch of toBatches(prepared, overlaps)) {
    if (signal.aborted) {
      results.push(...batch.map((p) => errorBlock(p.call.id, 'Not run: the turn was interrupted.')));
      continue;
    }
    results.push(...(await Promise.all(batch.map((p) => runCall(p, config, host, signal)))));
  }
  return results;
}

const FINISH_NOTICES: Partial<Record<FinishReason, { level: 'warning' | 'error'; text: string }>> = {
  max_tokens: { level: 'warning', text: 'The reply reached the output limit and was cut off.' },
  refusal: { level: 'error', text: 'The model declined to continue with this request.' },
  context_window: { level: 'warning', text: 'The conversation filled the model\'s context window. Use /compact or start a new session.' }
};

const OVERFLOW_MESSAGE = 'The conversation is too long for this model. Use /compact or start a new session.';

/** Tools that don't change the project's files; a turn that used nothing else has nothing to verify or check. */
const LOOKING_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Symbols', 'SemanticCode', 'WebFetch', 'WebSearch', 'Browser', 'Task', 'TodoWrite', 'AskUserQuestion', 'ShellOutput']);

function changesSomething(call: ToolUseBlock): boolean {
  if (call.name === 'Shell') {
    const command = (call.input as { command?: unknown } | null)?.command;
    return typeof command !== 'string' || classifyCommand(command) !== 'read-only';
  }
  // Looking at what ComfyUI has installed changes nothing; running a workflow saves files.
  if (call.name === 'ComfyUI') return (call.input as { action?: unknown } | null)?.action === 'run';
  return !LOOKING_TOOLS.has(call.name);
}

/**
 * Runs one user turn: stream a response, execute its tool calls, feed the
 * results back, and repeat until the model stops calling tools. Never
 * throws: failures end the turn with reason "error" and a message.
 */
export async function runAgentLoop(initial: LlmMessage[], config: LoopConfig, host: LoopHost, signal: AbortSignal): Promise<LoopResult> {
  let history = [...initial];
  let usage = EMPTY_USAGE;
  let lastContext = 0;
  let toolCalls = 0;
  let finalText = '';
  let reviewed = false;
  let todoNudges = 0;
  // Taproot verifies only real work: this turn changed something or planned with TodoWrite.
  let changed = false;
  let planned = false;
  // The project's checks run after the turn's work; a failure is sent back for a fix.
  let checkRounds = 0;
  let repeatStrikes = 0;
  // The provider refused the last request as too long: compact once, whatever the estimate says.
  let overflow = false;
  let overflowRecovered = false;
  // The model that answers. It changes at most once a turn: when the first keeps failing and the host has a backup.
  let active: LoopModel = { provider: config.provider, model: config.model, effort: config.effort };
  let switched = false;
  const recent: string[] = [];
  const done = (reason: LoopResult['reason'], error: LoopResult['error'] = null): LoopResult => ({ reason, error, usage, toolCalls, finalText, changed });

  for (let iteration = 0; ; iteration++) {
    if (signal.aborted) return done('interrupted');
    if (config.maxIterations !== null && iteration >= config.maxIterations) {
      host.emit({
        type: 'notice',
        level: 'warning',
        text: `Paused after ${config.maxIterations} steps, the limit set in Settings → Permissions.`,
        action: 'continue'
      });
      return done('guard');
    }

    const estimate = lastContext > 0 ? lastContext : estimateMessagesTokens(history) + estimateTextTokens(config.system);
    try {
      const compacted = await host.maybeCompact(history, estimate, signal, overflow);
      if (compacted) {
        history = compacted;
        lastContext = 0;
      } else if (overflow) {
        return done('error', { code: 'context_length', message: OVERFLOW_MESSAGE });
      }
    } catch (error) {
      if (signal.aborted) return done('interrupted');
      host.emit({ type: 'notice', level: 'warning', text: `Couldn't compact the conversation: ${(error as Error).message}` });
      if (overflow) return done('error', { code: 'context_length', message: OVERFLOW_MESSAGE });
    }
    overflow = false;

    const messageId = randomUUID();
    host.emit({ type: 'assistant-start', messageId });
    const blocks: ContentBlock[] = [];
    let pendingText = '';
    let pendingThinking = '';
    let finish: FinishReason = 'other';
    let responseUsage: Usage | null = null;
    let responseCost: number | null = null;
    const request: StreamRequest = {
      model: active.model,
      system: config.system,
      // Thinking belongs to the model that did it: another model gets the history without.
      messages: config.stripThinking || switched ? withoutThinking(history) : history,
      tools: config.registry.specs(config.toolNames),
      effort: active.effort,
      webSearch: config.webSearch && active.model.supportsWebSearch,
      cacheKey: config.cacheKey,
      privacy: config.privacy
    };

    let failure: ProviderError | null = null;
    try {
      for await (const event of streamWithRetry(
        active.provider,
        request,
        signal,
        (info) => host.emit({ type: 'retrying', attempt: info.attempt, delayMs: info.delayMs, reason: info.error.message }),
        config.retryPolicy
      )) {
        switch (event.type) {
          case 'text-delta':
            pendingText += event.text;
            host.emit({ type: 'assistant-delta', messageId, kind: 'text', text: event.text });
            break;
          case 'thinking-delta':
            pendingThinking += event.text;
            host.emit({ type: 'assistant-delta', messageId, kind: 'thinking', text: event.text });
            break;
          case 'block':
            blocks.push(event.block);
            if (event.block.type === 'text') pendingText = '';
            if (event.block.type === 'thinking') pendingThinking = '';
            break;
          case 'usage':
            responseUsage = event.usage;
            responseCost = event.costUsd ?? null;
            break;
          case 'finish':
            finish = event.reason;
            break;
        }
      }
    } catch (error) {
      failure = error instanceof ProviderError ? error : new ProviderError('unknown', (error as Error).message, { retryable: false, cause: error });
    }
    // A failed or cancelled stream may never emit its final blocks. Retain the
    // summaries already visible in the UI, without inventing provider signatures.
    if (pendingThinking.length > 0) blocks.push({ type: 'thinking', text: pendingThinking, display: 'summary', origin: active.provider.kind });
    if (pendingText.length > 0) blocks.push({ type: 'text', text: pendingText });

    // Some servers send no usage at all, or zeros (an OpenAI-compatible endpoint that
    // rejects stream_options reports nothing). Counting that as a real reading would
    // blank the context meter and store 0 in the session, so keep the last one instead.
    if (responseUsage && contextTokens(responseUsage) > 0) {
      usage = addUsage(usage, responseUsage);
      lastContext = contextTokens(responseUsage);
      host.onUsage(responseUsage, lastContext, responseCost ?? usageCost(active.model.pricing, responseUsage));
    }

    const aborted = signal.aborted || failure?.code === 'aborted';
    const content = blocks.filter((b) => !(b.type === 'text' && b.text.length === 0));
    if (content.length > 0) {
      const meta: MessageMeta = { turnId: config.turnId, model: active.model.ref, ...(responseUsage ? { usage: responseUsage } : {}) };
      if (aborted) meta.interrupted = true;
      else if (failure) meta.error = { code: failure.code, message: failure.message };
      const stored = host.append('assistant', content, meta, messageId);
      host.emit({ type: 'message', message: stored });
      history.push({ role: 'assistant', content });
      const text = textOf(content);
      if (text.length > 0) finalText = text;
    }
    if (aborted) return done('interrupted');
    // Too long for the model, and nothing came back: the estimate was off (an endpoint with an
    // unknown or smaller window than listed). Make room once and send the request again.
    if (failure?.code === 'context_length' && content.length === 0 && !overflowRecovered) {
      overflowRecovered = true;
      overflow = true;
      iteration--;
      continue;
    }
    // The model kept failing through its retries and nothing of a reply arrived, so nothing would be
    // said twice: another model may finish the turn. Once, so two failing models can't trade it forever.
    const reason = failure ? FALLBACK_REASONS[failure.code] : undefined;
    if (failure && reason && content.length === 0 && !switched && host.fallback) {
      let next: LoopModel | null = null;
      try {
        next = await host.fallback(failure);
      } catch (error) {
        host.log('warn', 'No backup model', { message: (error as Error).message });
      }
      if (signal.aborted) return done('interrupted');
      if (next) {
        host.emit({ type: 'notice', level: 'warning', text: `${active.model.label} isn't answering (${reason}). Continuing with ${next.model.label}.` });
        host.log('warn', 'Continuing on the backup model', { code: failure.code, from: active.model.ref.modelId, to: next.model.ref.modelId });
        active = next;
        switched = true;
        iteration--;
        continue;
      }
    }
    if (failure) {
      host.log('warn', 'Model request failed', { code: failure.code, message: failure.message });
      return done('error', { code: failure.code, message: failure.message });
    }

    const calls = content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    if (calls.length === 0) {
      if (finish === 'pause') continue;
      // The reply ran out of room, not out of things to say: make room once and let the agent carry on.
      if (finish === 'context_window' && !overflowRecovered) {
        overflowRecovered = true;
        overflow = true;
        iteration--;
        continue;
      }
      const notice = FINISH_NOTICES[finish];
      if (notice) host.emit({ type: 'notice', level: notice.level, text: notice.text });
      if (host.hooks?.has('Stop') && finish === 'stop') {
        const verdict = await host.hooks.run('Stop', { session_id: config.sessionId, last_message: finalText.slice(0, 20_000) }, signal);
        for (const e of verdict.errors) host.emit({ type: 'notice', level: 'warning', text: e });
        if (verdict.decision === 'block' && verdict.reason && !signal.aborted) {
          const text = `A Stop hook asked you to keep going: ${verdict.reason}`;
          const stored = host.append('user', [{ type: 'text', text }], { turnId: config.turnId, kind: 'reminder' });
          host.emit({ type: 'message', message: stored });
          history.push({ role: 'user', content: [{ type: 'text', text }] });
          continue;
        }
      }
      // Taproot keeps going while the plan it made this turn has open tasks (a few nudges at most), then
      // verifies once. A question or a look around (even with read-only commands) just gets its answer.
      const open = config.taproot && planned && finish === 'stop' ? host.todos().filter((t) => t.status !== 'completed') : [];
      if (open.length > 0 && todoNudges < MAX_TODO_NUDGES) {
        todoNudges++;
        const text = taprootOpenTasks(open.map((t) => t.content));
        const stored = host.append('user', [{ type: 'text', text }], { turnId: config.turnId, kind: 'reminder' });
        host.emit({ type: 'message', message: stored });
        history.push({ role: 'user', content: [{ type: 'text', text }] });
        continue;
      }
      if (config.taproot && !reviewed && (changed || planned) && finish === 'stop') {
        reviewed = true;
        const stored = host.append('user', [{ type: 'text', text: TAPROOT_REVIEW }], { turnId: config.turnId, kind: 'reminder' });
        host.emit({ type: 'message', message: stored });
        history.push({ role: 'user', content: [{ type: 'text', text: TAPROOT_REVIEW }] });
        continue;
      }
      // The turn changed files, so the project's own checks decide whether the work
      // actually holds up. A failure goes back to the model a few times, then stands.
      if (changed && finish === 'stop' && host.checks) {
        const report = await host.checks(checkRounds + 1, signal);
        // No report: the turn was stopped, or the checks couldn't run (the host said why).
        if (report === null) return done(signal.aborted ? 'interrupted' : 'completed');
        const summary = checksSummary(report);
        const stored = host.append('user', [{ type: 'text', text: summary }], { turnId: config.turnId, kind: 'check', check: report });
        host.emit({ type: 'message', message: stored });
        if (!report.passed) {
          const text = checksFailurePrompt(report);
          if (config.checksFix && checkRounds < MAX_CHECK_ROUNDS) {
            checkRounds++;
            history.push({ role: 'user', content: [{ type: 'text', text }] });
            host.append('user', [{ type: 'text', text }], { turnId: config.turnId, kind: 'reminder' });
            continue;
          }
          host.emit({ type: 'notice', level: 'warning', text: `${summary} Fix them before committing.` });
        }
      }
      return done('completed');
    }

    if (calls.some((c) => c.name === 'TodoWrite')) planned = true;
    const signature = JSON.stringify(calls.map((c) => [c.name, c.input]));
    recent.push(signature);
    if (recent.length > 3) recent.shift();
    const repeating = recent.length === 3 && recent.every((s) => s === signature);
    if (repeating) repeatStrikes++;

    const results = await executeCalls(calls, config, host, signal);
    toolCalls += calls.length;
    // A refused or failed edit changed nothing; a failed command may still have written files.
    const failed = new Set(results.filter((r) => r.type === 'tool_result' && r.isError).map((r) => (r.type === 'tool_result' ? r.toolUseId : '')));
    if (calls.some((c) => changesSomething(c) && (c.name === 'Shell' || !failed.has(c.id)))) changed = true;
    const userContent: ContentBlock[] = [...results];
    if (repeating) {
      userContent.push({
        type: 'text',
        text: 'You made the same tool calls three times in a row. Stop repeating them: change your approach, or explain what is blocking you.'
      });
    }
    const stored = host.append('user', userContent, { turnId: config.turnId });
    host.emit({ type: 'message', message: stored });
    // Display metadata is for the UI only; keep it out of what the model is sent.
    history.push({
      role: 'user',
      content: userContent.map((b) => (b.type === 'tool_result' ? { type: 'tool_result', toolUseId: b.toolUseId, content: b.content, isError: b.isError } : b))
    });
    if (signal.aborted) return done('interrupted');
    // Messages sent with "Send now" join the tool results, as replay does (mergeAdjacent), so roles keep alternating.
    const steering = ((await host.takeSteering?.(signal)) ?? []).flat();
    const last = history.at(-1);
    if (steering.length > 0 && last?.role === 'user') history[history.length - 1] = { role: 'user', content: [...last.content, ...steering] };
    if (repeatStrikes >= 2) {
      host.emit({ type: 'notice', level: 'warning', text: 'Stopped: the agent kept repeating the same tool calls.' });
      return done('guard');
    }
  }
}
