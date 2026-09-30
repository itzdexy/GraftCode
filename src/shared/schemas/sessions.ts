import { z } from 'zod';
import { EffortLevelSchema, ModelRefSchema, PermissionModeSchema, UsageSchema } from './common';
import { StoredMessageSchema } from './messages';
import { TodoItemSchema } from './toolDisplay';
import { PermissionRequestSchema, QuestionRequestSchema } from './permissions';

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

export const QueuedInputSchema = z.object({ id: z.string(), text: z.string(), imageCount: z.number().int().nonnegative(), createdAt: z.number().int() });
export type QueuedInput = z.infer<typeof QueuedInputSchema>;

export const SessionDetailSchema = z.object({
  summary: SessionSummarySchema,
  messages: z.array(StoredMessageSchema),
  todos: z.array(TodoItemSchema),
  pendingPermission: PermissionRequestSchema.nullable(),
  pendingQuestion: QuestionRequestSchema.nullable(),
  queue: z.array(QueuedInputSchema)
});
export type SessionDetail = z.infer<typeof SessionDetailSchema>;
