import { z } from 'zod';

/**
 * UI-only metadata attached to tool results. It is stored with the message
 * but never sent to a model provider.
 */
export const TodoItemSchema = z.object({
  id: z.string(),
  content: z.string(),
  activeForm: z.string().optional(),
  status: z.enum(['pending', 'in_progress', 'completed'])
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

/** A file a chat made for the user to download (stored in the chat's folder under this name). */
export const MadeFileSchema = z.object({ name: z.string(), size: z.number().int().nonnegative(), mime: z.string() });
export type MadeFile = z.infer<typeof MadeFileSchema>;

export const ToolDisplaySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('read'),
    path: z.string(),
    startLine: z.number().int(),
    endLine: z.number().int(),
    totalLines: z.number().int(),
    image: z.boolean()
  }),
  z.object({
    kind: z.literal('edit'),
    path: z.string(),
    created: z.boolean(),
    patch: z.string(),
    added: z.number().int(),
    removed: z.number().int()
  }),
  z.object({ kind: z.literal('glob'), pattern: z.string(), count: z.number().int(), files: z.array(z.string()) }),
  z.object({ kind: z.literal('grep'), pattern: z.string(), count: z.number().int(), preview: z.string() }),
  z.object({
    kind: z.literal('shell'),
    command: z.string(),
    cwd: z.string(),
    exitCode: z.number().int().nullable(),
    output: z.string(),
    truncated: z.boolean(),
    logPath: z.string().nullable(),
    durationMs: z.number().int(),
    timedOut: z.boolean(),
    interrupted: z.boolean(),
    backgroundId: z.string().nullable()
  }),
  z.object({
    kind: z.literal('shell-output'),
    shellId: z.string(),
    status: z.enum(['running', 'exited', 'killed', 'failed']),
    exitCode: z.number().int().nullable(),
    output: z.string()
  }),
  z.object({ kind: z.literal('kill-shell'), shellId: z.string(), killed: z.boolean() }),
  z.object({ kind: z.literal('fetch'), url: z.string(), status: z.number().int(), bytes: z.number().int(), title: z.string().nullable() }),
  z.object({ kind: z.literal('todos'), todos: z.array(TodoItemSchema) }),
  z.object({ kind: z.literal('task'), description: z.string(), summary: z.string(), toolCalls: z.number().int() }),
  z.object({
    kind: z.literal('question'),
    answers: z.array(z.object({ question: z.string(), answer: z.string().nullable() }))
  }),
  z.object({ kind: z.literal('plan'), plan: z.string(), approved: z.boolean(), feedback: z.string().nullable() }),
  z.object({ kind: z.literal('mcp'), server: z.string(), tool: z.string(), text: z.string() }),
  z.object({
    kind: z.literal('web-search'),
    query: z.string(),
    /** `site` names the site when the URL is a redirect. */
    results: z.array(z.object({ title: z.string(), url: z.string(), site: z.string().optional() }))
  }),
  MadeFileSchema.extend({ kind: z.literal('file'), preview: z.string().nullable() }),
  z.object({
    kind: z.literal('code'),
    code: z.string(),
    output: z.string(),
    error: z.string().nullable(),
    timedOut: z.boolean(),
    durationMs: z.number().int().nonnegative(),
    files: z.array(MadeFileSchema)
  }),
  z.object({ kind: z.literal('denied'), reason: z.string() }),
  z.object({ kind: z.literal('error'), message: z.string() }),
  z.object({ kind: z.literal('text'), text: z.string() })
]);
export type ToolDisplay = z.infer<typeof ToolDisplaySchema>;
