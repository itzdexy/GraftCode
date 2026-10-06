import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentEvent } from '../../src/shared/schemas/agentEvents';
import { textOf, type ContentBlock, type LlmMessage, type StoredMessage } from '../../src/shared/schemas/messages';
import type { ModelInfo } from '../../src/shared/schemas/models';
import { runAgentLoop, type LoopConfig, type LoopHost, type LoopModel, type LoopResult } from '../../src/main/agent/loop';
import type { Decision } from '../../src/main/permissions/engine';
import type { RetryPolicy } from '../../src/main/providers/retry';
import { ToolRegistry } from '../../src/main/tools/registry';
import { textResult, type PermissionClass, type ToolDefinition } from '../../src/main/tools/types';
import { FakeProvider, fakeModel, type FakeStep } from './fakeProvider';
import { makeToolContext } from './toolContext';

/** A tool for tests: what it does is up to `run`, which is told which call it is serving. */
export function testTool(
  name: string,
  options: { safe?: boolean; permissionClass?: PermissionClass; run?: (input: Record<string, unknown>) => Promise<string> | string } = {}
): ToolDefinition<Record<string, unknown>> {
  const safe = options.safe ?? false;
  return {
    name,
    description: `Test tool ${name}.`,
    input: z.record(z.string(), z.unknown()),
    permissionClass: options.permissionClass ?? (safe ? 'read' : 'write'),
    concurrencySafe: () => safe,
    timeoutMs: 10_000,
    describe: (input) => Promise.resolve({ summary: `${name} ${JSON.stringify(input)}` }),
    execute: async (input) => textResult(await (options.run ? options.run(input) : `${name} ran`), { kind: 'text', text: name })
  };
}

export const allow: Decision = { behavior: 'allow', reason: 'test', dangerous: null, outsideProject: false, suggestedRule: null };

export interface LoopHarnessOptions {
  script: FakeStep[];
  tools: Array<ToolDefinition<Record<string, unknown>>>;
  model?: Partial<ModelInfo>;
  /** What the permission rules say about a call (default: allow everything). */
  decide?: (toolName: string) => Decision;
  /** Called before each request; returning a history stands in for a compaction. */
  maybeCompact?: (history: LlmMessage[], contextTokens: number, overflow: boolean) => LlmMessage[] | null;
  retry?: RetryPolicy;
  maxIterations?: number | null;
  /** The replies of a second model, which the host offers when the first keeps failing. */
  backup?: FakeStep[];
  /** The host's answer when the loop asks for another model, given the backup model (null without `backup`). Default: that model. */
  fallback?: (offer: LoopModel | null) => Promise<LoopModel | null>;
}

export interface LoopHarness {
  provider: FakeProvider;
  /** The second model's provider, when the test gave it replies. */
  backup: FakeProvider | null;
  events: AgentEvent[];
  stored: StoredMessage[];
  /** The conversation as the model is sent it, after the run. */
  run(prompt: string, signal?: AbortSignal): Promise<LoopResult>;
  notices(): string[];
}

/** Runs the agent loop on its own, with scripted model replies and tools of the test's choosing. */
export function makeLoopHarness(options: LoopHarnessOptions): LoopHarness {
  const model = fakeModel(options.model);
  const provider = new FakeProvider(options.script, [model]);
  const backupModel = fakeModel({ ref: { providerId: 'backup', modelId: 'backup-model' }, label: 'Backup Model' });
  const backup = options.backup ? new FakeProvider(options.backup, [backupModel], 'backup') : null;
  const offer: LoopModel | null = backup ? { provider: backup, model: backupModel, effort: null } : null;
  const registry = new ToolRegistry();
  for (const tool of options.tools) registry.register(tool);
  const events: AgentEvent[] = [];
  const stored: StoredMessage[] = [];
  const ctx = makeToolContext(process.cwd());
  const host: LoopHost = {
    append: (role, content: ContentBlock[], meta, id) => {
      const message: StoredMessage = { id: id ?? randomUUID(), sessionId: 'session-test', seq: stored.length, role, content, meta, createdAt: Date.now() };
      stored.push(message);
      return message;
    },
    emit: (event) => events.push(event),
    decide: (query) => (options.decide ? options.decide(query.toolName) : allow),
    askPermission: () => Promise.resolve({ decision: 'allow-once' }),
    toolContext: (toolUseId, signal) => ({ ...ctx, toolUseId, signal }),
    describeContext: () => ({ cwd: ctx.cwd, projectRoot: ctx.projectRoot, platform: ctx.platform }),
    hooks: null,
    maybeCompact: (history, tokens, _signal, overflow) => Promise.resolve(options.maybeCompact ? options.maybeCompact(history, tokens, overflow === true) : null),
    onUsage: () => undefined,
    todos: () => [],
    log: () => undefined,
    ...(offer || options.fallback ? { fallback: () => (options.fallback ? options.fallback(offer) : Promise.resolve(offer)) } : {})
  };
  const config: LoopConfig = {
    provider,
    model,
    registry,
    toolNames: registry.names(),
    system: 'You are a test agent.',
    effort: null,
    webSearch: false,
    cacheKey: 'session-test',
    privacy: { noTraining: false, zeroRetention: false },
    turnId: 'turn-1',
    maxIterations: options.maxIterations ?? null,
    retryPolicy: options.retry ?? { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 1 },
    agentLabel: null,
    taproot: false,
    checksFix: false,
    stripThinking: false,
    sessionId: 'session-test'
  };
  return {
    provider,
    backup,
    events,
    stored,
    run: (prompt, signal = new AbortController().signal) => runAgentLoop([{ role: 'user', content: [{ type: 'text', text: prompt }] }], config, host, signal),
    notices: () => events.flatMap((e) => (e.type === 'notice' ? [e.text] : []))
  };
}

/** Text of every tool result in a stored user message, in order. */
export function resultTexts(message: StoredMessage | undefined): string[] {
  return (message?.content ?? []).flatMap((b) => (b.type === 'tool_result' ? [textOf(b.content.flatMap((c) => (c.type === 'text' ? [{ type: 'text' as const, text: c.text }] : [])))] : []));
}
