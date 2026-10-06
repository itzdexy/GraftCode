import { z } from 'zod';
import { ModelRefSchema, ProviderKindSchema, UsageSchema } from './common';
import { ToolDisplaySchema } from './toolDisplay';

/** Provider-neutral conversation content. Adapters translate to wire formats. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

export const TextBlockSchema = z.object({ type: z.literal('text'), text: z.string() });
export const ImageBlockSchema = z.object({
  type: z.literal('image'),
  mediaType: z.enum(IMAGE_MEDIA_TYPES),
  /** Base64 without a data: prefix. */
  data: z.string()
});
export const ThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  text: z.string(),
  /** Provider signature; blocks without one are never replayed. */
  signature: z.string().optional(),
  /** "update": a between-tool progress note; "summary": reasoning summary. */
  display: z.enum(['update', 'summary']).optional(),
  origin: ProviderKindSchema.optional()
});
export const RedactedThinkingBlockSchema = z.object({ type: z.literal('redacted_thinking'), data: z.string() });
export const ToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
  /** Provider round-trip data (e.g. Gemini thought signatures). */
  meta: z.record(z.string(), z.string()).optional()
});
export const ToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  toolUseId: z.string(),
  content: z.array(z.discriminatedUnion('type', [TextBlockSchema, ImageBlockSchema])),
  isError: z.boolean(),
  display: ToolDisplaySchema.optional()
});
/**
 * Provider-specific blocks that must be echoed back verbatim to the same
 * provider (e.g. server-side web search calls and results). Other providers
 * never see them.
 */
export const ProviderBlockSchema = z.object({
  type: z.literal('provider'),
  provider: ProviderKindSchema,
  raw: z.unknown(),
  summary: z.string(),
  /** A provider-side web search, normalized for display: the query block has no results, the results block no query. */
  search: z.object({ query: z.string(), results: z.array(z.object({ title: z.string(), url: z.string(), site: z.string().optional() })) }).optional()
});

export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ImageBlockSchema,
  ThinkingBlockSchema,
  RedactedThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ProviderBlockSchema
]);

export type TextBlock = z.infer<typeof TextBlockSchema>;
export type ImageBlock = z.infer<typeof ImageBlockSchema>;
export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>;
export type RedactedThinkingBlock = z.infer<typeof RedactedThinkingBlockSchema>;
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;
export type ProviderBlock = z.infer<typeof ProviderBlockSchema>;
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export type ToolResultContent = ToolResultBlock['content'][number];

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

/** A text file attached to a message (sent to the model as text, shown as a chip). */
export const FileAttachmentSchema = z.object({
  name: z.string().min(1).max(255),
  content: z.string().max(200_000)
});
export type FileAttachment = z.infer<typeof FileAttachmentSchema>;

/** "mission": what starts each turn of a mission after its first (the mission restated); the transcript shows it as a marker, not as something the user wrote. */
export const MessageKindSchema = z.enum(['normal', 'compaction-summary', 'reminder', 'command-output', 'notice', 'shell', 'check', 'mission']);
export type MessageKind = z.infer<typeof MessageKindSchema>;

/** The project's checks after a turn changed files (meta of a "check" message): each command run, in order. */
export const CheckReportSchema = z.object({
  passed: z.boolean(),
  runs: z.array(
    z.object({
      command: z.string(),
      exitCode: z.number().int().nullable(),
      /** The end of the output. */
      output: z.string(),
      truncated: z.boolean(),
      durationMs: z.number(),
      timedOut: z.boolean(),
      passed: z.boolean()
    })
  ),
  /** 1 for the checks after the turn's work, 2 and up after each round of fixes. */
  round: z.number().int().min(1)
});
export type CheckReport = z.infer<typeof CheckReportSchema>;

/** A command the user ran with "!" in the message box, and what it printed (meta of a "shell" message). */
export const UserShellSchema = z.object({
  command: z.string(),
  cwd: z.string(),
  exitCode: z.number().int().nullable(),
  /** The end of the output (the model gets the same text, cut in the middle when long). */
  output: z.string(),
  truncated: z.boolean(),
  durationMs: z.number(),
  timedOut: z.boolean(),
  interrupted: z.boolean()
});
export type UserShell = z.infer<typeof UserShellSchema>;

export const MessageMetaSchema = z.object({
  turnId: z.string().optional(),
  kind: MessageKindSchema.optional(),
  /** Replaced by a compaction summary; kept for display, not sent to models. */
  compacted: z.boolean().optional(),
  /** The message that stands for this one: a summary, or the note /clear left. A rewind that removes it brings this one back. */
  compactedBy: z.string().optional(),
  /** On the message /clear leaves: nothing before it is current any more (see shared/plans.ts). */
  cleared: z.boolean().optional(),
  feedback: z.union([z.literal(-1), z.literal(0), z.literal(1)]).optional(),
  usage: UsageSchema.optional(),
  model: ModelRefSchema.optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  interrupted: z.boolean().optional(),
  checkpointId: z.string().optional(),
  /** Queued text or slash command as typed, when the stored content was expanded. */
  typed: z.string().optional(),
  /** Names of text files attached to this message. */
  attachments: z.array(z.string()).optional(),
  shell: UserShellSchema.optional(),
  check: CheckReportSchema.optional(),
  /** On a "mission" message: the turn it starts, of how many, and whether it follows checks that failed. */
  mission: z.object({ turn: z.number().int(), of: z.number().int(), afterChecks: z.boolean() }).optional()
});
export type MessageMeta = z.infer<typeof MessageMetaSchema>;

export const StoredMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  seq: z.number().int(),
  role: z.enum(['user', 'assistant']),
  content: z.array(ContentBlockSchema),
  meta: MessageMetaSchema,
  createdAt: z.number().int()
});
export type StoredMessage = z.infer<typeof StoredMessageSchema>;

export function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}
