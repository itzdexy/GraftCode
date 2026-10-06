import { z } from 'zod';
import { EffortLevelSchema, ModelRefSchema, PermissionModeSchema, UsageSchema } from './common';
import { StoredMessageSchema } from './messages';
import { TodoItemSchema } from './toolDisplay';
import { PermissionRequestSchema, QuestionRequestSchema } from './permissions';
import { AgentRunSchema } from './agentRuns';
import { MissionSchema } from './missions';

export const SessionStatusSchema = z.enum(['idle', 'running', 'needs-input', 'error']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionKindSchema = z.enum(['chat', 'code']);
export type SessionKind = z.infer<typeof SessionKindSchema>;

export const SessionUsageSchema = z.object({
  totals: UsageSchema,
  /** Tokens in the model's context after the last request. */
  contextTokens: z.number().int().nonnegative(),
  contextLimit: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable()
});
export type SessionUsage = z.infer<typeof SessionUsageSchema>;

/** One part of what a request holds, with its estimated size. */
export const ContextPartSchema = z.object({
  id: z.enum(['system', 'tools', 'mcp', 'user', 'replies', 'results', 'reasoning']),
  label: z.string(),
  tokens: z.number().int().nonnegative()
});
export type ContextPart = z.infer<typeof ContextPartSchema>;

/**
 * What a session's next request would hold: the parts (estimated from the text, largest
 * first), the provider's own count of the last request when there is one, and the
 * model's context window (0 when unknown).
 */
export const ContextReportSchema = z.object({
  parts: z.array(ContextPartSchema),
  measured: z.number().int().nonnegative().nullable(),
  limit: z.number().int().nonnegative()
});
export type ContextReport = z.infer<typeof ContextReportSchema>;

export const ErrorInfoSchema = z.object({ code: z.string(), message: z.string() });
export type ErrorInfo = z.infer<typeof ErrorInfoSchema>;

export const SessionSummarySchema = z.object({
  id: z.string(),
  kind: SessionKindSchema,
  title: z.string(),
  status: SessionStatusSchema,
  pinned: z.boolean(),
  archived: z.boolean(),
  unread: z.boolean(),
  incognito: z.boolean(),
  projectId: z.string().nullable(),
  projectPath: z.string().nullable(),
  projectName: z.string().nullable(),
  cwd: z.string().nullable(),
  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  baseBranch: z.string().nullable(),
  model: ModelRefSchema.nullable(),
  effort: EffortLevelSchema.nullable(),
  permissionMode: PermissionModeSchema,
  lastError: ErrorInfoSchema.nullable(),
  usage: SessionUsageSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int()
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/** A message waiting for the running turn; `steer` ones reach the agent at its next step instead of after the turn. */
export const QueuedInputSchema = z.object({
  id: z.string(),
  text: z.string(),
  attachmentCount: z.number().int().nonnegative(),
  createdAt: z.number().int(),
  steer: z.boolean().default(false)
});
export type QueuedInput = z.infer<typeof QueuedInputSchema>;

export const SessionDetailSchema = z.object({
  summary: SessionSummarySchema,
  messages: z.array(StoredMessageSchema),
  todos: z.array(TodoItemSchema),
  pendingPermission: PermissionRequestSchema.nullable(),
  pendingQuestion: QuestionRequestSchema.nullable(),
  queue: z.array(QueuedInputSchema),
  /** Agents run as groups in this session, for the agent graph. */
  agentRuns: z.array(AgentRunSchema).default([]),
  /** The session's newest mission, whatever its state; null when it never had one. */
  mission: MissionSchema.nullable().default(null)
});
export type SessionDetail = z.infer<typeof SessionDetailSchema>;
