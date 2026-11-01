import { randomUUID } from 'node:crypto';
import { GraftError } from '@shared/errors';
import type { EffortLevel } from '@shared/schemas/common';
import type { LlmMessage } from '@shared/schemas/messages';
import type { ModelInfo } from '@shared/schemas/models';
import type { RetryPolicy } from '../providers/retry';
import type { LLMProvider, RequestPrivacy } from '../providers/types';
import { PARENT_ONLY_TOOLS } from '../tools/builtin';
import type { ToolRegistry } from '../tools/registry';
import { attemptLabel, type AttemptAgentCall } from './attempts';
import { runAgentLoop, type LoopConfig, type LoopHost } from './loop';
import { workspaceHost } from './workspaceHost';

/**
 * One attempt's agent (attempts.ts): the session's conversation, prompt and
 * permission mode, in a private checkout of its own. Like a writing sub-agent,
 * it never delegates, asks the user, plans or drives the one browser and screen;
 * unlike one, nothing it does reaches the session's folder until it is applied.
 */

/** The steps of an attempt when Settings sets no limit, as for a sub-agent: it works on one message, so it stays bounded. */
export const ATTEMPT_STEPS = 200;

/** The session's tools an attempt may use: none that delegate, ask the user, plan, or use what there is one of. */
export function attemptTools(sessionTools: readonly string[]): string[] {
  const withheld = new Set<string>([...PARENT_ONLY_TOOLS, 'Computer']);
  return sessionTools.filter((name) => !withheld.has(name));
}

/** What an attempt is told besides the session's own prompt; "Attempt 2 of 3" also tells the attempts apart. */
export function attemptBrief(index: number, of: number, cwd: string): string {
  return [
    `# Attempt ${String(index)} of ${String(of)}`,
    `You are one of ${String(of)} independent attempts at the user's latest message, each working in a private checkout of its own. The user compares the attempts and applies one to the project; nothing you change reaches it before that.`,
    `Your working directory is ${cwd}. Use relative paths. Ignored files and dependency folders such as node_modules are not copied here; the project's checks run in your checkout once you finish.`,
    'Do the work as you would in the project itself, then end with a short report: what you changed, and how you checked it.'
  ].join('\n');
}

export interface AttemptLoop {
  call: AttemptAgentCall;
  /** The session's loop host for this attempt's model: permissions, tool context, hooks, usage and the turn's limits. */
  host: LoopHost;
  provider: LLMProvider;
  model: ModelInfo;
  /** The session's conversation, the message the attempts answer last. */
  history: LlmMessage[];
  system: string;
  toolNames: string[];
  toolDescriptions?: Partial<Record<string, string>>;
  registry: ToolRegistry;
  effort: EffortLevel | null;
  privacy: RequestPrivacy;
  sessionId: string;
  turnId: string;
  maxIterations: number;
  retryPolicy?: RetryPolicy;
}

/** Runs one attempt's agent to its report. Throws when it did not finish: stopped, failed, or cut short by a limit. */
export async function runAttemptLoop(input: AttemptLoop, signal: AbortSignal): Promise<{ report: string; touched: string[] }> {
  const { call } = input;
  const isolated = await workspaceHost(input.host, call.lease);
  const touched = new Set<string>();
  let seq = 0;
  const host: LoopHost = {
    ...isolated.host,
    // An attempt's own conversation is not stored: the card says how it went, and the one applied is said in the session.
    append: (role, content, meta, id) => {
      for (const block of content) if (block.type === 'tool_result' && !block.isError && block.display?.kind === 'edit') touched.add(block.display.path);
      return { id: id ?? randomUUID(), sessionId: input.sessionId, seq: ++seq, role, content, meta, createdAt: Date.now() };
    },
    emit: (event) => {
      if (event.type === 'tool-start') call.activity(event.summary);
      else if (event.type === 'notice') input.host.emit(event);
    },
    maybeCompact: () => Promise.resolve(null),
    todos: () => [],
    takeSteering: () => Promise.resolve([]),
    // The session pays for its attempts and the turn's limits count them all; the attempt's own totals go on its card.
    onUsage: (usage, _context, costUsd) => {
      isolated.host.onUsage(usage, null, costUsd);
      call.usage(usage, costUsd);
    }
  };
  const config: LoopConfig = {
    provider: input.provider,
    model: input.model,
    registry: input.registry,
    toolNames: input.toolNames,
    ...(input.toolDescriptions ? { toolDescriptions: input.toolDescriptions } : {}),
    system: input.system,
    effort: input.effort,
    webSearch: false,
    cacheKey: `${input.sessionId}:${input.turnId}:attempt-${String(call.index)}`,
    privacy: input.privacy,
    turnId: `${input.turnId}:attempt-${String(call.index)}`,
    maxIterations: input.maxIterations,
    ...(input.retryPolicy ? { retryPolicy: input.retryPolicy } : {}),
    // Its permission cards say which attempt asks.
    agentLabel: attemptLabel(call.index, input.model.label),
    taproot: false,
    // Its checks run once it finished (attempts.ts), in its checkout.
    checksFix: false,
    stripThinking: false,
    sessionId: input.sessionId
  };
  try {
    const result = await runAgentLoop(input.history, config, host, signal);
    if (result.reason === 'interrupted' || signal.aborted) throw new GraftError('interrupted', 'Stopped.');
    if (result.reason === 'error') throw new GraftError('attempt_failed', result.error?.message ?? 'The model request failed.');
    if (result.reason === 'guard') {
      const over = host.overBudget?.() ?? null;
      if (over !== null) throw new GraftError('turn_limit', `Stopped: the turn reached a limit before this attempt finished. ${over}`);
      const last = result.finalText.trim();
      throw new GraftError('attempt_stuck', `Stopped before it finished: it reached its step limit or kept repeating the same steps.${last ? ` Its last words: ${last.slice(-1500)}` : ''}`);
    }
    return { report: result.finalText.trim(), touched: [...touched] };
  } finally {
    // Its background commands stop before its changes are taken.
    await isolated.close();
  }
}
