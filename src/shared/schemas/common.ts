import { z } from 'zod';

/**
 * Effort levels shown in the UI, weakest first. "none" turns reasoning off and
 * "minimal" is the lightest reasoning, both only for models that offer them.
 * "taproot" is Graft's long-horizon mode above Max: the provider runs at its
 * highest effort and the agent loop gets larger budgets plus a verification
 * pass before it may finish.
 */
export const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'extra', 'max', 'taproot'] as const;
export const EffortLevelSchema = z.enum(EFFORT_LEVELS);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;
export const RECOMMENDED_EFFORT: EffortLevel = 'medium';

export const PROVIDER_KINDS = ['anthropic', 'openai', 'gemini', 'openrouter', 'ollama', 'openai-compatible'] as const;
export const ProviderKindSchema = z.enum(PROVIDER_KINDS);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const PERMISSION_MODES = ['ask', 'auto-edit', 'plan', 'auto', 'bypass'] as const;
export const PermissionModeSchema = z.enum(PERMISSION_MODES);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const ModelRefSchema = z.object({
  providerId: z.string().min(1).max(200),
  modelId: z.string().min(1).max(300)
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const IdSchema = z.string().min(1).max(100);

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative()
});
export type Usage = z.infer<typeof UsageSchema>;

export const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens
  };
}
