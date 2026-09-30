import { z } from 'zod';

export const RewindModeSchema = z.enum(['files', 'conversation', 'both']);
export type RewindMode = z.infer<typeof RewindModeSchema>;

export const RewindFileChangeSchema = z.object({
  path: z.string(),
  change: z.enum(['restore', 'recreate', 'delete'])
});
export type RewindFileChange = z.infer<typeof RewindFileChangeSchema>;

export const RewindPreviewSchema = z.object({
  messageId: z.string(),
  /** Messages from the chosen one onward that a conversation rewind removes. */
  messagesRemoved: z.number().int().nonnegative(),
  /** null when no checkpoint exists for that message (files can't be restored). */
  files: z.array(RewindFileChangeSchema).nullable(),
  /** Text of the chosen message, returned to the composer after a conversation rewind. */
  restoredText: z.string()
});
export type RewindPreview = z.infer<typeof RewindPreviewSchema>;

export const RewindResultSchema = z.object({
  files: z.array(RewindFileChangeSchema).nullable(),
  messagesRemoved: z.number().int().nonnegative(),
  restoredText: z.string(),
  /** Checkpoint holding the pre-rewind files, so the rewind can be undone. */
  undoCheckpointId: z.string().nullable()
});
export type RewindResult = z.infer<typeof RewindResultSchema>;
