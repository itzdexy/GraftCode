import { z } from 'zod';
import { ModelRefSchema, UsageSchema } from './common';

/**
 * Agents run as a group by RunAgents: one record per agent, kept with the
 * session so the agent graph and its history survive restarts.
 */

/** The kinds of work a model can be assigned to in Settings → Models. */
export const MODEL_ROLES = ['planner', 'coder', 'reviewer', 'security', 'browser', 'vision', 'research', 'fast'] as const;
export const ModelRoleSchema = z.enum(MODEL_ROLES);
export type ModelRoleId = z.infer<typeof ModelRoleSchema>;

export const MODEL_ROLE_LABELS: Record<ModelRoleId, string> = {
  planner: 'Planner',
  coder: 'Coder',
  reviewer: 'Reviewer',
  security: 'Security',
  browser: 'Browser',
  vision: 'Vision',
  research: 'Research',
  fast: 'Fast'
};

export const MODEL_ROLE_HELP: Record<ModelRoleId, string> = {
  planner: 'Plans and designs: planner and architect agents.',
  coder: 'Changes code: implementer, tester and debugger agents.',
  reviewer: 'Reviews diffs and performance.',
  security: 'Security reviews.',
  browser: 'Tests the running app in the browser.',
  vision: 'Looks at screenshots: the UI reviewer. Needs a model that sees images.',
  research: 'Reads documentation and the web.',
  fast: 'Quick reading work: explorer and documentation agents.'
};

export const AgentRunStatusSchema = z.enum(['queued', 'running', 'retrying', 'done', 'failed', 'skipped', 'cancelled']);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const AgentTimelineEntrySchema = z.object({
  at: z.number().int(),
  kind: z.enum(['start', 'tool', 'retry', 'verify', 'end']),
  text: z.string()
});
export type AgentTimelineEntry = z.infer<typeof AgentTimelineEntrySchema>;

export const AgentRunSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  /** The RunAgents call that started the group. */
  groupId: z.string(),
  /** What the group as a whole is for. */
  goal: z.string(),
  /** The agent's id within its group; other agents name it in dependsOn. */
  nodeId: z.string(),
  role: z.string(),
  roleLabel: z.string(),
  title: z.string(),
  prompt: z.string(),
  dependsOn: z.array(z.string()),
  status: AgentRunStatusSchema,
  /** Counts the changes to this record, so a view that hears two of them out of order keeps the later one. */
  rev: z.number().int(),
  /** The attempt that is running or ran last (0 before the first). */
  attempt: z.number().int(),
  maxAttempts: z.number().int(),
  model: ModelRefSchema.extend({ label: z.string() }).nullable(),
  /** Why this model, in plain sentences. */
  routing: z.array(z.string()),
  /** The tools this agent may use. */
  tools: z.array(z.string()),
  /** Has the project (or the browser) to itself, so it runs one at a time. */
  exclusive: z.boolean(),
  /** The paths it may change, when it was given some: it then works beside agents holding other paths. */
  writes: z.array(z.string()).default([]),
  budget: z.object({ maxTokens: z.number().int().nullable(), timeoutMs: z.number().int() }),
  createdAt: z.number().int(),
  startedAt: z.number().int().nullable(),
  endedAt: z.number().int().nullable(),
  usage: UsageSchema,
  /** Null when the model has no published prices. */
  costUsd: z.number().nullable(),
  toolCalls: z.number().int(),
  /** Tool name → times used. */
  toolsUsed: z.record(z.string(), z.number().int()),
  filesChanged: z.array(z.string()),
  /** The agent's final report. */
  result: z.string(),
  error: z.string().nullable(),
  /** Attempts that failed before the current one. */
  retries: z.array(z.object({ attempt: z.number().int(), error: z.string(), at: z.number().int() })),
  /** The command that had to pass for the work to count, and how it went (null: none was asked for). */
  verify: z.object({ command: z.string(), passed: z.boolean().nullable(), output: z.string(), rounds: z.number().int() }).nullable(),
  /** What happened, in order: the newest 200 entries. */
  timeline: z.array(AgentTimelineEntrySchema)
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

/** Still going: counts as work in progress in the graph. */
export function agentRunActive(status: AgentRunStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'retrying';
}
