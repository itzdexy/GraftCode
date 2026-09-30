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
  summary: z.string()
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

export const MessageKindSchema = z.enum(['normal', 'compaction-summary', 'reminder', 'command-output', 'notice']);
export type MessageKind = z.infer<typeof MessageKindSchema>;

export const MessageMetaSchema = z.object({
  turnId: z.string().optional(),
  kind: MessageKindSchema.optional(),
  /** Replaced by a compaction summary; kept for display, not sent to models. */
  compacted: z.boolean().optional(),
  feedback: z.union([z.literal(-1), z.literal(0), z.literal(1)]).optional(),
  usage: UsageSchema.optional(),
  model: ModelRefSchema.optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  interrupted: z.boolean().optional(),
  checkpointId: z.string().optional(),
  /** Queued text or slash command as typed, when the stored content was expanded. */
  typed: z.string().optional()
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
