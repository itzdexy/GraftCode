import { z } from 'zod';
import { PermissionModeSchema } from './common';
import { StoredMessageSchema } from './messages';
import { PermissionRequestSchema, QuestionRequestSchema } from './permissions';
import { ErrorInfoSchema, QueuedInputSchema, SessionStatusSchema, SessionUsageSchema } from './sessions';
import { TodoItemSchema } from './toolDisplay';

/**
 * Events a running session streams to the renderer. Completed messages
 * arrive as `message`; the in-flight assistant reply streams as deltas first.
 */
export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('turn-start'), turnId: z.string() }),
  z.object({ type: z.literal('message'), message: StoredMessageSchema }),
  z.object({ type: z.literal('assistant-start'), messageId: z.string() }),
  z.object({
    type: z.literal('assistant-delta'),
    messageId: z.string(),
    kind: z.enum(['text', 'thinking']),
    text: z.string()
  }),
  z.object({ type: z.literal('tool-start'), toolUseId: z.string(), name: z.string(), summary: z.string() }),
  z.object({ type: z.literal('tool-progress'), toolUseId: z.string(), chunk: z.string() }),
  z.object({ type: z.literal('permission'), request: PermissionRequestSchema }),
  z.object({ type: z.literal('permission-resolved'), requestId: z.string() }),
  z.object({ type: z.literal('question'), request: QuestionRequestSchema }),
  z.object({ type: z.literal('question-resolved'), requestId: z.string() }),
  z.object({ type: z.literal('todos'), todos: z.array(TodoItemSchema) }),
  z.object({ type: z.literal('status'), status: SessionStatusSchema, error: ErrorInfoSchema.nullable() }),
  z.object({ type: z.literal('usage'), usage: SessionUsageSchema }),
  z.object({ type: z.literal('notice'), level: z.enum(['info', 'warning', 'error']), text: z.string() }),
  z.object({ type: z.literal('queue'), queue: z.array(QueuedInputSchema) }),
  z.object({ type: z.literal('retrying'), attempt: z.number().int(), delayMs: z.number().int(), reason: z.string() }),
  z.object({ type: z.literal('compacted'), summaryMessageId: z.string() }),
  z.object({ type: z.literal('mode'), permissionMode: PermissionModeSchema }),
  z.object({ type: z.literal('title'), title: z.string() }),
  z.object({
    type: z.literal('turn-end'),
    turnId: z.string(),
    reason: z.enum(['completed', 'interrupted', 'error', 'guard'])
  })
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
