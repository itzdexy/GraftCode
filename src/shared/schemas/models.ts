import { z } from 'zod';
import { EffortLevelSchema, ModelRefSchema, ProviderKindSchema } from './common';

export const EffortSupportSchema = z.object({
  levels: z.array(EffortLevelSchema).min(1),
  recommended: EffortLevelSchema,
  default: EffortLevelSchema
});
export type EffortSupport = z.infer<typeof EffortSupportSchema>;

export const ModelInfoSchema = z.object({
  ref: ModelRefSchema,
  label: z.string(),
  description: z.string(),
  /** Grouping key used to pick the featured (newest) model of each line. */
  family: z.string(),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  supportsTools: z.boolean(),
  supportsVision: z.boolean(),
  supportsWebSearch: z.boolean(),
  /** null hides the effort control for this model. */
  effort: EffortSupportSchema.nullable(),
  featured: z.boolean(),
  /** Suitable for background work such as titles and commit messages. */
  cheap: z.boolean(),
  createdAt: z.number().int().nullable(),
  /** USD per million tokens, when the provider publishes it; null means unknown. */
  pricing: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }).nullable()
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const CustomModelSchema = z.object({
  id: z.string().min(1).max(300),
  label: z.string().max(120).optional(),
  contextWindow: z.number().int().min(1024).max(10_000_000).optional(),
  maxOutputTokens: z.number().int().min(256).max(1_000_000).optional(),
  vision: z.boolean().optional()
});
export type CustomModel = z.infer<typeof CustomModelSchema>;

export const ProviderSummarySchema = z.object({
  id: z.string(),
  kind: ProviderKindSchema,
  label: z.string(),
  baseUrl: z.string().nullable(),
  hasKey: z.boolean(),
  enabled: z.boolean(),
  isDefault: z.boolean(),
  createdAt: z.number().int(),
  customModels: z.array(CustomModelSchema)
});
export type ProviderSummary = z.infer<typeof ProviderSummarySchema>;

export const VerifyErrorCodeSchema = z.enum([
  'auth',
  'rate_limit',
  'network',
  'bad_base_url',
  'not_found',
  'bad_request',
  'server',
  'overloaded',
  'context_length',
  'aborted',
  'unknown'
]);
export type ProviderErrorCode = z.infer<typeof VerifyErrorCodeSchema>;

export const VerifyResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), modelCount: z.number().int().nonnegative() }),
  z.object({ ok: z.literal(false), code: VerifyErrorCodeSchema, message: z.string() })
]);
export type VerifyResult = z.infer<typeof VerifyResultSchema>;
