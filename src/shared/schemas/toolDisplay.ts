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

/** What kind of generated file something is; decides how the transcript shows it. */
export const MediaKindSchema = z.enum(['image', 'video', 'gif', 'audio', 'file']);
export type MediaKind = z.infer<typeof MediaKindSchema>;

/** A picture or clip an image model or ComfyUI made: where it was saved, and a small preview for pictures. */
export const MediaFileSchema = z.object({
  /** Relative to the project in code sessions; the file's name in chats. */
  path: z.string(),
  kind: MediaKindSchema,
  bytes: z.number().int().nonnegative(),
  /** Base64 JPEG preview; null for clips and where no preview could be made. */
  thumb: z.string().nullable()
});
export type MediaFile = z.infer<typeof MediaFileSchema>;

export const ToolDisplaySchema = z.discriminatedUnion('kind', [
  /** Generated media (GenerateImage, ComfyUI). `costUsd` is what the provider charged: 0 on this computer, null when unknown. */
  z.object({
    kind: z.literal('media'),
    engine: z.string(),
    model: z.string(),
    prompt: z.string(),
    costUsd: z.number().nullable(),
    files: z.array(MediaFileSchema)
  }),
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
  /** `url` is where the page answered from; `requested` is the address that was asked for, when the page had moved. */
  z.object({ kind: z.literal('fetch'), url: z.string(), requested: z.string().optional(), status: z.number().int(), bytes: z.number().int(), title: z.string().nullable() }),
  /** A computer-use step; the screenshot rides along in the result's content, the point is where it acted (screenshot pixels). */
  z.object({
    kind: z.literal('computer'),
    action: z.string(),
    summary: z.string(),
    point: z.object({ x: z.number(), y: z.number() }).nullable(),
    width: z.number(),
    height: z.number()
  }),
  /** The agent drove the Browser panel; a screenshot rides along in the result's content. */
  z.object({ kind: z.literal('browser'), action: z.string(), url: z.string(), title: z.string(), detail: z.string() }),
  z.object({ kind: z.literal('todos'), todos: z.array(TodoItemSchema) }),
  z.object({ kind: z.literal('task'), description: z.string(), summary: z.string(), toolCalls: z.number().int() }),
  /** A group of agents (RunAgents): what each one was and how it ended. The full records are in the agent graph. */
  z.object({
    kind: z.literal('agents'),
    goal: z.string(),
    agents: z.array(z.object({ nodeId: z.string(), title: z.string(), role: z.string(), status: z.string(), durationMs: z.number().int().nullable() })),
    /** The pages its agents read and found on the web: the conversation's own sources, like the ones the main agent opened. */
    sources: z.array(z.object({ url: z.string(), title: z.string().nullable(), state: z.enum(['read', 'found']) })).optional()
  }),
  /** A MissionUpdate call: a note for the notebook, or the agent reporting the mission done or blocked. */
  z.object({ kind: z.literal('mission'), action: z.enum(['note', 'done', 'blocked']), noteKind: z.string().nullable(), text: z.string() }),
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
