import { z } from 'zod';
import { EffortLevelSchema, ModelRefSchema, ProviderKindSchema } from './common';

export const EffortSupportSchema = z.object({
  levels: z.array(EffortLevelSchema).min(1),
  recommended: EffortLevelSchema,
  default: EffortLevelSchema,
  /** Provider wire value per level (a named level or a thinking-token budget); adapters read it. */
  values: z.partialRecord(EffortLevelSchema, z.union([z.string(), z.number()])).optional()
});
export type EffortSupport = z.infer<typeof EffortSupportSchema>;

export const ModelAvailabilitySchema = z.object({
  state: z.enum(['available', 'cataloged-unverified', 'not-accessible', 'deprecated', 'confirmed-retired', 'temporarily-unavailable', 'unknown']),
  source: z.enum(['provider', 'catalog', 'custom', 'cache']),
  checkedAt: z.number().int().nullable(), reason: z.string().nullable(), selectable: z.boolean()
});
export type ModelAvailability = z.infer<typeof ModelAvailabilitySchema>;

export const ModelLifecycleSchema = z.object({
  shutdownDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((date) => {
    const time = Date.parse(`${date}T00:00:00Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date;
  }, 'Invalid shutdown date'),
  source: z.literal('openai-models-api'),
  sourceUrl: z.literal('https://api.openai.com/v1/models')
});
export type ModelLifecycle = z.infer<typeof ModelLifecycleSchema>;

export const ModelInfoSchema = z.object({
  availability: ModelAvailabilitySchema.optional(),
  lifecycle: ModelLifecycleSchema.optional(),
  /** Published catalog evidence; null means unknown rather than an inferred capability. */
  catalogCapabilities: z.object({ tools: z.boolean().nullable(), vision: z.boolean().nullable(), reasoning: z.boolean().nullable(),
    audio: z.boolean().nullable(), structured: z.boolean().nullable() }).optional(),
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
  /**
   * USD per million tokens, when the provider publishes it; null means unknown.
   * Cache reads and writes are billed at the input price when their own price is missing.
   */
  pricing: z
    .object({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cacheRead: z.number().nonnegative().optional(),
      cacheWrite: z.number().nonnegative().optional()
    })
    .nullable()
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

/** A provider Graft knows how to reach: native adapters plus the OpenAI-compatible catalog. */
export const ProviderPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: ProviderKindSchema,
  /** May contain ${PLACEHOLDER} parts (account ids) the user fills in. */
  baseUrl: z.string().nullable(),
  key: z.enum(['required', 'optional', 'none']),
  docUrl: z.string().nullable(),
  envVars: z.array(z.string()),
  modelCount: z.number().int().nonnegative(),
  local: z.boolean()
});
export type ProviderPreset = z.infer<typeof ProviderPresetSchema>;

export const ProviderSummarySchema = z.object({
  id: z.string(),
  kind: ProviderKindSchema,
  /** Catalog preset this provider was created from (null for a custom endpoint). */
  preset: z.string().nullable(),
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
