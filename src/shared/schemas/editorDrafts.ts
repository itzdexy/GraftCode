import { z } from 'zod';

export const EditorDraftSchema = z.object({
  content: z.string().max(512 * 1024), original: z.string().max(512 * 1024), revision: z.string().regex(/^[a-f0-9]{64}$/)
});
export type EditorDraft = z.infer<typeof EditorDraftSchema>;
export const StoredEditorDraftSchema = EditorDraftSchema.extend({ path: z.string().min(1).max(4096), updatedAt: z.number().int().nonnegative() });
