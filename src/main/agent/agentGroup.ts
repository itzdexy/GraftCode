import { randomUUID } from 'node:crypto';
import { validateGraph } from '@shared/agentGraph';
import { normalizeScope, scopeProblem } from '@shared/writeScopes';
import { GraftError } from '@shared/errors';
import type { AgentRun, AgentTimelineEntry, ModelRoleId } from '@shared/schemas/agentRuns';
import type { AgentEvent } from '@shared/schemas/agentEvents';
import { addUsage, EMPTY_USAGE, type EffortLevel, type ModelRef } from '@shared/schemas/common';
import { textOf, type StoredMessage, type ToolUseBlock } from '@shared/schemas/messages';
import type { ModelInfo } from '@shared/schemas/models';
import { sourcesOf, type Source } from '@shared/sources';
import { ProviderError } from '../providers/errors';
import type { RetryPolicy } from '../providers/retry';
import type { LLMProvider, RequestPrivacy } from '../providers/types';
import { FileStateTracker } from '../tools/fileState';
import type { ToolRegistry } from '../tools/registry';
import type { AgentDefinition } from './agents';
import { toLlmHistory } from './history';
import { backupReason, runAgentLoop, runToolCall, type LoopConfig, type LoopHost } from './loop';
import { routeModel, type Route } from './modelRouter';
import { runGraph, type GraphControl, type NodeState } from './orchestrator';
import { resolveRole, type ResolvedRole } from './roles';
import { spentTokens } from './turnBudget';
import { outsideScope } from './writeScope';
import type { AgentWorkspaces } from './workspaces';
import { workspaceHost } from './workspaceHost';

/**
 * A group of agents started by RunAgents. Each agent gets a role, a fresh
 * context, a model chosen for the role, a time limit and (optionally) a token
 * budget and a command that must pass. The scheduling is the orchestrator's;
 * this module turns one graph node into one agent loop and keeps a record of
 * everything it did, saved with the session and shown in the agent graph.
 */

export interface AgentSpec {
  id: string;
  role: string;
  task: string;
  prompt: string;
  depends_on?: string[] | undefined;
  verify?: string | undefined;
  /** The paths this agent may change. With them it works beside agents that hold other paths; without, an agent that writes has the project to itself. */
  writes?: string[] | undefined;
}

export interface AgentGroupInput {
  goal: string;
  agents: AgentSpec[];
}

export interface AgentGroupSettings {
  routing: 'session' | 'auto';
  roles: Partial<Record<ModelRoleId, ModelRef | null>>;
  maxParallel: number;
  tokenBudget: number | null;
  retries: number;
}

/** What a group needs from the session it runs in. */
export interface GroupHost {
  sessionId: string;
  /** The session's system prompt; each agent's role is added to it. */
  system: string;
  /** The tools the session has: an agent never gets one that isn't here. */
  toolNames: string[];
  customAgents: AgentDefinition[];
  sessionModel: ModelInfo;
  sessionProvider: LLMProvider;
  settings: AgentGroupSettings;
  registry: ToolRegistry;
  privacy: RequestPrivacy;
  /** Model steps before an agent is stopped. */
  maxSteps: number;
  retryPolicy?: RetryPolicy;
  /** Every model the user can use, for routing. */
  candidates(signal: AbortSignal): Promise<ModelInfo[]>;
  resolve(ref: ModelRef, signal: AbortSignal): Promise<{ provider: LLMProvider; model: ModelInfo }>;
  /**
   * The loop host an agent builds on: permission prompts, tool context, hooks, the session's usage,
   * and the backup model, which has to see when the agent's work is looking at pictures.
   */
  loopHost(model: ModelInfo, provider: LLMProvider, needsVision: boolean): LoopHost;
  workspaces?: AgentWorkspaces;
  effort(model: ModelInfo): EffortLevel | null;
  /** Stores an agent's record and tells the interface. */
  save(run: AgentRun): void;
  /** Receives the way to stop one agent (by its id in the group) while the group runs. */
  onControl?(control: GraphControl): void;
  /** A line of progress under the RunAgents call in the transcript. */
  progress(text: string): void;
  notice(event: Extract<AgentEvent, { type: 'notice' }>): void;
}

export interface AgentGroupResult {
  report: string;
  runs: AgentRun[];
  /** The pages the agents read and found on the web, each once. */
  sources: Source[];
}

/** The most pages a group hands back: its result is stored with the conversation. */
const SOURCES_MAX = 200;

/** Rounds of "run the check, send its failure back" before an agent's work counts as failed. */
const VERIFY_ROUNDS = 3;
const REPORT_CLIP = 8_000;
const DEPENDENCY_CLIP = 6_000;
const TIMELINE_MAX = 200;

function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (shortened; the full report is in the agent graph)` : text;
}

function seconds(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${String(s)}s` : `${String(Math.floor(s / 60))}m ${String(s % 60)}s`;
}

interface Planned {
  spec: AgentSpec;
  role: Extract<ResolvedRole, { ok: true }>;
  route: Route;
  /** The paths it may change, when it was given some; empty otherwise. */
  writes: string[];
  /** It needs the project (or the browser) to itself. */
  alone: boolean;
}

const WRITE_TOOLS = ['Edit', 'MultiEdit', 'Write'];

export async function runAgentGroup(input: AgentGroupInput, groupId: string, host: GroupHost, signal: AbortSignal): Promise<AgentGroupResult> {
  const problem = validateGraph(input.agents.map((a) => ({ id: a.id, dependsOn: a.depends_on ?? [] })));
  if (problem) throw new GraftError('bad_agent_graph', problem);

  const candidates = await host.candidates(signal).catch(() => [host.sessionModel]);
  const planned = new Map<string, Planned>();
  for (const spec of input.agents) {
    const role = resolveRole(spec.role, host.toolNames, host.customAgents);
    if (!role.ok) throw new GraftError('unknown_role', role.error);
    const route = routeModel({ modelRole: role.modelRole, needsVision: role.needsVision, session: host.sessionModel, candidates, routing: host.settings.routing, assignments: host.settings.roles });
    if (spec.writes !== undefined) {
      if (!role.tools.some((tool) => WRITE_TOOLS.includes(tool))) {
        throw new GraftError('bad_agent_graph', `"${spec.id}" has the ${role.label} role, which changes no files, so it can't be given writes. Use implementer, tester, debugger or docs for an agent that writes.`);
      }
      const problem = scopeProblem(spec.writes);
      if (problem) throw new GraftError('bad_agent_graph', `"${spec.id}": ${problem}`);
    }
    const writes = (spec.writes ?? []).map(normalizeScope);
    planned.set(spec.id, { spec, role, route, writes, alone: role.exclusive && writes.length === 0 });
  }

  const runs = new Map<string, AgentRun>();
  /** Every message of every agent, for the pages they read and found. */
  const seen: StoredMessage[] = [];
  const created = Date.now();
  const change = (id: string, patch: Partial<AgentRun>, entry?: Omit<AgentTimelineEntry, 'at'>): void => {
    const current = runs.get(id);
    if (!current) return;
    const next: AgentRun = {
      ...current,
      ...patch,
      rev: current.rev + 1,
      timeline: entry ? [...current.timeline, { at: Date.now(), ...entry }].slice(-TIMELINE_MAX) : (patch.timeline ?? current.timeline)
    };
    runs.set(id, next);
    host.save(next);
  };
  for (const { spec, role, route, writes, alone } of planned.values()) {
    const run: AgentRun = {
      id: randomUUID(),
      sessionId: host.sessionId,
      groupId,
      goal: input.goal,
      nodeId: spec.id,
      role: role.role,
      roleLabel: role.label,
      title: spec.task,
      prompt: spec.prompt,
      dependsOn: spec.depends_on ?? [],
      status: 'queued',
      rev: 0,
      attempt: 0,
      maxAttempts: host.settings.retries + 1,
      model: { ...route.ref, label: route.model.label },
      routing: route.reasons,
      tools: role.tools,
      exclusive: alone,
      writes,
      budget: { maxTokens: host.settings.tokenBudget, timeoutMs: role.timeoutMs },
      createdAt: created,
      startedAt: null,
      endedAt: null,
      usage: EMPTY_USAGE,
      costUsd: null,
      toolCalls: 0,
      toolsUsed: {},
      filesChanged: [],
      result: '',
      error: null,
      retries: [],
      verify: spec.verify ? { command: spec.verify, passed: null, output: '', rounds: 0 } : null,
      timeline: []
    };
    runs.set(spec.id, run);
    host.save(run);
  }

  const onState = (id: string, state: NodeState): void => {
    const now = Date.now();
    const run = runs.get(id);
    if (!run) return;
    switch (state.status) {
      case 'running':
        change(id, { status: 'running', attempt: state.attempt, startedAt: run.startedAt ?? now, error: null }, { kind: 'start', text: state.attempt > 1 ? `Attempt ${String(state.attempt)}` : `Started on ${run.model?.label ?? 'the session model'}` });
        break;
      case 'retrying':
        change(id, { status: 'retrying', retries: [...run.retries, { attempt: state.attempt, error: state.error ?? 'failed', at: now }] }, { kind: 'retry', text: `Attempt ${String(state.attempt)} failed: ${state.error ?? 'unknown error'}` });
        break;
      case 'done':
        change(id, { status: 'done', endedAt: now }, { kind: 'end', text: 'Finished' });
        break;
      case 'failed':
        change(id, { status: 'failed', error: state.error, endedAt: now }, { kind: 'end', text: `Failed: ${state.error ?? 'unknown error'}` });
        break;
      case 'skipped':
      case 'cancelled':
        change(id, { status: state.status, error: state.error, endedAt: now }, { kind: 'end', text: state.status === 'skipped' ? (state.error ?? 'Skipped') : 'Stopped' });
        break;
      case 'queued':
        break;
    }
  };

  const outcomes = await runGraph<string>({
    nodes: [...planned.values()].map(({ spec, role, writes, alone }) => ({
      id: spec.id,
      dependsOn: spec.depends_on ?? [],
      exclusive: alone,
      ...(writes.length > 0 ? { paths: writes } : {}),
      maxAttempts: host.settings.retries + 1,
      timeoutMs: role.timeoutMs
    })),
    concurrency: host.settings.maxParallel,
    signal,
    // Another attempt helps when the provider failed; it doesn't when the agent was refused, ran out of budget or failed its check.
    isRetryable: (error) => error instanceof ProviderError && error.retryable,
    onState,
    onControl: (control) => host.onControl?.(control),
    run: (node, _attempt, nodeSignal, deps) => {
      const plan = planned.get(node.id);
      if (!plan) throw new GraftError('internal', `No plan for ${node.id}.`);
      return runAgent(plan, input.goal, groupId, host, nodeSignal, deps, planned, (patch, entry) => change(node.id, patch, entry), () => runs.get(node.id), (message) => seen.push(message));
    }
  });

  for (const [id, outcome] of outcomes) {
    if (outcome.status === 'done' && outcome.value !== null) change(id, { result: outcome.value });
  }
  const finished = [...runs.values()];
  const count = (status: AgentRun['status']): number => finished.filter((r) => r.status === status).length;
  const tally = [
    count('done') > 0 ? `${String(count('done'))} finished` : '',
    count('failed') > 0 ? `${String(count('failed'))} failed` : '',
    count('skipped') > 0 ? `${String(count('skipped'))} skipped` : '',
    count('cancelled') > 0 ? `${String(count('cancelled'))} stopped` : ''
  ]
    .filter(Boolean)
    .join(', ');
  const sections = finished.map((run) => {
    const took = run.startedAt !== null && run.endedAt !== null ? ` · ${seconds(run.endedAt - run.startedAt)}` : '';
    const head = `## ${run.nodeId}: ${run.title} [${run.roleLabel} · ${run.status}${took}]`;
    if (run.status === 'done') {
      const checked = run.verify ? `\n\nCheck \`${run.verify.command}\`: passed.` : '';
      return `${head}\n${clip(run.result, REPORT_CLIP)}${checked}`;
    }
    return `${head}\n${run.error ?? 'It did not finish.'}`;
  });
  return { report: `Agents: ${tally || 'none ran'}.\n\n${sections.join('\n\n')}`, runs: finished, sources: sourcesOf(seen).slice(0, SOURCES_MAX) };
}

async function runAgent(
  plan: Planned,
  goal: string,
  groupId: string,
  host: GroupHost,
  signal: AbortSignal,
  deps: Map<string, string>,
  planned: Map<string, Planned>,
  change: (patch: Partial<AgentRun>, entry?: Omit<AgentTimelineEntry, 'at'>) => void,
  current: () => AgentRun | undefined,
  saw: (message: StoredMessage) => void
): Promise<string> {
  const { spec, role, route, writes } = plan;
  const { provider, model } = sameModel(route.ref, host.sessionModel.ref) ? { provider: host.sessionProvider, model: host.sessionModel } : await host.resolve(route.ref, signal);

  // The agent's own stop: its time limit and a stop of the turn arrive on `signal`; running out of budget is decided here.
  const stop = new AbortController();
  const forward = (): void => stop.abort();
  signal.addEventListener('abort', forward, { once: true });
  let spent = 0;
  let overBudget = false;
  const scratch: StoredMessage[] = [];
  const original = host.loopHost(model, provider, role.needsVision);
  const lease = host.workspaces && role.tools.some((tool) => WRITE_TOOLS.includes(tool))
    ? await host.workspaces.create(original.describeContext().cwd, signal) : null;
  if (lease) change({ workspace: lease.info }, { kind: 'start', text: 'Working in a private checkout; integration checks for destination conflicts.' });
  let privateHost: Awaited<ReturnType<typeof workspaceHost>> | null = null;
  try { privateHost = lease ? await workspaceHost(original, lease) : null; }
  catch (error) { if (lease) change({ workspace: host.workspaces?.retain(lease) }); throw error; }
  const parent = privateHost?.host ?? original;
  const finish = async (report: string): Promise<string> => {
    if (lease && host.workspaces) {
      // Stop private background commands before capturing the final changes.
      await privateHost?.close();
      const workspace = await host.workspaces.integrate(lease, writes, stop.signal, current()?.filesChanged ?? []);
      change({ workspace }, { kind: 'end', text: 'Private changes integrated; patch retained for review.' });
    }
    return report;
  };
  const where = parent.describeContext();
  // What the agent has read is its own: with a fresh context it has seen nothing, so it reads a file before it changes it.
  const ownFiles = new FileStateTracker(where.platform);
  const loopHost: LoopHost = {
    append: (messageRole, content, meta, id) => {
      const message: StoredMessage = { id: id ?? randomUUID(), sessionId: host.sessionId, seq: scratch.length + 1, role: messageRole, content, meta, createdAt: Date.now() };
      scratch.push(message);
      saw(message);
      const touched = content.flatMap((block) => {
        const display = block.type === 'tool_result' && !block.isError ? block.display : undefined;
        if (display?.kind === 'edit') return [display.path];
        if (display?.kind === 'media') return display.files.map((file) => file.path);
        return [];
      });
      if (touched.length > 0) change({ filesChanged: [...new Set([...(current()?.filesChanged ?? []), ...touched])] });
      return message;
    },
    emit: (event) => {
      if (event.type === 'tool-start') {
        host.progress(`${spec.id}: ${event.summary}\n`);
        const now = current();
        change({ toolCalls: (now?.toolCalls ?? 0) + 1, toolsUsed: { ...(now?.toolsUsed ?? {}), [event.name]: (now?.toolsUsed[event.name] ?? 0) + 1 } }, { kind: 'tool', text: event.summary });
      } else if (event.type === 'notice') host.notice(event);
    },
    decide: (query) => {
      // An agent with paths of its own is kept to them, whatever the permission mode allows: another agent may be in the rest.
      const outside = writes.length > 0 ? outsideScope(query.descriptor.writes ?? [], writes, where.projectRoot, where.platform) : [];
      if (outside.length > 0) {
        return {
          behavior: 'deny',
          reason: `${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} not yours to change: you may change only ${writes.join(', ')}. Other agents may be working on the rest. Leave it, and say in your report what needs changing there.`,
          dangerous: null,
          outsideProject: false,
          suggestedRule: null
        };
      }
      return parent.decide(query);
    },
    askPermission: (request, s) => parent.askPermission(request, s),
    toolContext: (toolUseId, s) => ({ ...parent.toolContext(toolUseId, s), files: ownFiles }),
    describeContext: () => where,
    hooks: parent.hooks,
    log: (level, message, fields) => parent.log(level, message, fields),
    // An agent works on one task in one context; it has no task list, no steering and no checks of its own.
    maybeCompact: () => Promise.resolve(null),
    todos: () => [],
    takeSteering: () => Promise.resolve([]),
    overBudget: () => parent.overBudget?.() ?? null,
    fallback: async (error, s) => {
      const next = (await parent.fallback?.(error, s)) ?? null;
      if (!next) return null;
      // The rounds after a failed check start on the model that works, not on the one that didn't answer.
      Object.assign(config, { provider: next.provider, model: next.model, effort: next.effort });
      const why = backupReason(error) ?? 'failing';
      change(
        { model: { ...next.model.ref, label: next.model.label }, routing: [...(current()?.routing ?? []), `${model.label} wasn't answering (${why}), so ${next.model.label} finished the work.`] },
        { kind: 'retry', text: `${model.label} wasn't answering (${why}). Continued on ${next.model.label}.` }
      );
      return next;
    },
    onUsage: (usage, _context, costUsd) => {
      // The session pays for its agents; the agent's own totals are kept beside it.
      parent.onUsage(usage, null, costUsd);
      const now = current();
      change({ usage: addUsage(now?.usage ?? EMPTY_USAGE, usage), costUsd: costUsd === null ? (now?.costUsd ?? null) : (now?.costUsd ?? 0) + costUsd });
      spent += spentTokens(usage);
      const limit = host.settings.tokenBudget;
      if (limit !== null && spent > limit && !overBudget) {
        overBudget = true;
        stop.abort();
      }
    }
  };

  const readsOnly = !role.tools.some((tool) => WRITE_TOOLS.includes(tool));
  const system = [
    host.system,
    ...(lease ? [`# Private writer checkout\nYour working directory is ${lease.cwd}. Use relative paths here. Ignored/generated files and dependency folders are not copied. Changes are integrated only after destination and scope checks; failed work stays here for recovery.`] : []),
    `# Your role in this group: ${role.label}`,
    `You are one agent in a group working towards this goal: "${goal}". Your task: "${spec.task}". ${role.brief}`,
    `You start with a fresh context: you see this brief and nothing of the conversation, and the main agent sees only your final message.${readsOnly ? ' You may not change files.' : ''}`,
    ...(writes.length > 0
      ? [
          `Other agents are changing other parts of the project while you work. You may change only: ${writes.join(', ')}. Change files with the edit tools, never by a shell command, and leave everything else as it is: if your task needs a change outside your paths, say so in your report instead of making it. A build or test of the whole project may meet their unfinished work, so run the narrowest checks that cover your own files.`
        ]
      : [])
  ].join('\n\n');
  const fromDeps = [...deps.entries()].map(([id, text]) => `### ${planned.get(id)?.spec.task ?? id} (${id})\n${clip(text, DEPENDENCY_CLIP)}`);
  const prompt = fromDeps.length > 0 ? `${spec.prompt}\n\n## Results from the agents this task depends on\n${fromDeps.join('\n\n')}` : spec.prompt;

  const config: LoopConfig = {
    provider,
    model,
    registry: host.registry,
    toolNames: role.tools,
    system,
    effort: host.effort(model),
    webSearch: false,
    cacheKey: `${host.sessionId}:${groupId}:${spec.id}`,
    privacy: host.privacy,
    turnId: `${groupId}:${spec.id}`,
    maxIterations: host.maxSteps,
    ...(host.retryPolicy ? { retryPolicy: host.retryPolicy } : {}),
    agentLabel: `${role.label}: ${spec.task}`,
    taproot: false,
    checksFix: false,
    stripThinking: false,
    sessionId: host.sessionId
  };

  try {
    loopHost.append('user', [{ type: 'text', text: prompt }], {});
    for (let round = 1; ; round++) {
      const result = await runAgentLoop(toLlmHistory(scratch), config, loopHost, stop.signal);
      if (overBudget) throw new GraftError('agent_budget', `Stopped: it used its budget of ${(host.settings.tokenBudget ?? 0).toLocaleString('en-US')} tokens.`);
      if (result.reason === 'interrupted') throw new GraftError('interrupted', 'Stopped.');
      // The turn's own limit, not this agent's doing: say which, instead of calling the agent stuck.
      const turnOver = result.reason === 'guard' ? (parent.overBudget?.() ?? null) : null;
      if (turnOver !== null) throw new GraftError('turn_limit', `Stopped: the turn reached a limit before this agent finished. ${turnOver}`);
      if (result.reason === 'error') {
        const code = result.error?.code ?? 'unknown';
        const retryable = ['rate_limit', 'overloaded', 'server', 'network'].includes(code);
        throw new ProviderError(retryable ? (code as 'rate_limit' | 'overloaded' | 'server' | 'network') : 'unknown', result.error?.message ?? 'The model request failed.', { retryable });
      }
      const report = result.finalText.trim();
      if (result.reason === 'guard' && report.length === 0) throw new GraftError('agent_stuck', 'Stopped: it kept repeating the same steps without reporting.');
      if (report.length === 0) throw new GraftError('agent_silent', 'It finished without a report.');
      if (!spec.verify) return await finish(report);

      // The check decides, not the agent's word for it. It runs like any command of the turn: permission rules and hooks apply.
      const call: ToolUseBlock = { type: 'tool_use', id: `verify-${randomUUID()}`, name: 'Shell', input: { command: spec.verify, description: `Check for ${spec.id}` } };
      const checked = await runToolCall(call, { ...config, toolNames: [...new Set([...role.tools, 'Shell'])] }, loopHost, stop.signal);
      if (stop.signal.aborted) throw new GraftError('interrupted', 'Stopped.');
      const shell = checked.display?.kind === 'shell' ? checked.display : null;
      const passed = shell !== null && !shell.timedOut && shell.exitCode === 0;
      const output = (shell?.output ?? textOf(checked.content)).slice(-4_000);
      change({ verify: { command: spec.verify, passed, output, rounds: round } }, { kind: 'verify', text: passed ? `Check passed: ${spec.verify}` : `Check failed (round ${String(round)}): ${spec.verify}` });
      if (passed) return await finish(report);
      if (round >= VERIFY_ROUNDS) throw new GraftError('agent_check_failed', `Its check still fails after ${String(VERIFY_ROUNDS)} rounds: ${spec.verify}\n${output.slice(-1_500)}`);
      loopHost.append(
        'user',
        [{ type: 'text', text: `The check \`${spec.verify}\` failed (round ${String(round)} of ${String(VERIFY_ROUNDS)}). Its output:\n\n${output}\n\nFind the cause and fix it; don't weaken the check. Then report again.` }],
        {}
      );
    }
  } finally {
    signal.removeEventListener('abort', forward);
    await privateHost?.close();
    if (lease && lease.info.state !== 'integrated') change({ workspace: host.workspaces?.retain(lease) });
  }
}
