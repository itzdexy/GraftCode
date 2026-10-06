import { z } from 'zod';

export const PermissionDetailSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('command'), command: z.string(), cwd: z.string(), background: z.boolean() }),
  z.object({ kind: z.literal('edit'), path: z.string(), patch: z.string(), created: z.boolean() }),
  z.object({ kind: z.literal('path'), path: z.string(), access: z.enum(['read', 'write']) }),
  z.object({ kind: z.literal('url'), url: z.string() }),
  z.object({ kind: z.literal('mcp'), server: z.string(), tool: z.string(), input: z.string() }),
  z.object({ kind: z.literal('plan'), plan: z.string() }),
  z.object({ kind: z.literal('generic'), text: z.string() })
]);
export type PermissionDetail = z.infer<typeof PermissionDetailSchema>;

export const PermissionRequestSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  toolUseId: z.string(),
  toolName: z.string(),
  title: z.string(),
  detail: PermissionDetailSchema,
  reason: z.string(),
  /** Why the action is considered destructive; such requests are never auto-approved. */
  dangerous: z.string().nullable(),
  outsideProject: z.boolean(),
  /** Rule written by "Always allow" / applied by "Allow for session"; null when none applies. */
  suggestedRule: z.string().nullable(),
  /** Label of the sub-agent that asked, when not the main agent. */
  agentLabel: z.string().nullable()
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

export const PermissionDecisionSchema = z.enum(['allow-once', 'allow-session', 'allow-always', 'deny']);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const PermissionResponseSchema = z.object({
  requestId: z.string(),
  decision: PermissionDecisionSchema,
  feedback: z.string().max(4000).optional(),
  /** With the approval of a plan: the plan as the user edited it. The agent follows this version. */
  plan: z.string().max(50_000).optional()
});
export type PermissionResponse = z.infer<typeof PermissionResponseSchema>;

export const QuestionSchema = z.object({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
  multiSelect: z.boolean()
});
export type Question = z.infer<typeof QuestionSchema>;

export const QuestionRequestSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  toolUseId: z.string(),
  questions: z.array(QuestionSchema).min(1)
});
export type QuestionRequest = z.infer<typeof QuestionRequestSchema>;

/** One entry per question; null means the question was skipped. */
export const QuestionAnswerSchema = z
  .object({ selected: z.array(z.string().max(500)).max(9), other: z.string().max(4000).optional() })
  .nullable();
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;

export const QuestionResponseSchema = z.object({
  requestId: z.string(),
  answers: z.array(QuestionAnswerSchema),
  dismissed: z.boolean().optional()
});
export type QuestionResponse = z.infer<typeof QuestionResponseSchema>;
