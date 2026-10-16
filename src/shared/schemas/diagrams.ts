import { z } from 'zod';

/**
 * Where a diagram is: a file of a code session's folder, by the path its
 * edit showed, or a file a chat made, by its name. The main process resolves
 * either against the session it was asked about and checks that the file is
 * a diagram before it shows or copies it.
 */
export const DiagramSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project'), path: z.string().min(1).max(4096) }),
  z.object({ kind: z.literal('chat'), name: z.string().min(1).max(200) })
]);
export type DiagramSource = z.infer<typeof DiagramSourceSchema>;
