import { z } from 'zod';
import { PermissionModeSchema } from './common';
import { RuleListSchema, SettingsScopeSchema } from './config';

/** Permission rules of one settings file, as shown in Settings → Permissions. */
export const ScopedRulesSchema = z.object({
  scope: SettingsScopeSchema,
  path: z.string(),
  /** Set when the file can't be read or parsed; it is then ignored and read-only here. */
  error: z.string().nullable(),
  allow: z.array(z.string()),
  ask: z.array(z.string()),
  deny: z.array(z.string()),
  defaultMode: PermissionModeSchema.nullable()
});
export type ScopedRules = z.infer<typeof ScopedRulesSchema>;

export const RuleListsSchema = z.object({ allow: RuleListSchema, ask: RuleListSchema, deny: RuleListSchema });
export type RuleLists = z.infer<typeof RuleListsSchema>;

/**
 * off: the user turned updates off. unsupported: development build or no
 * update feed configured for this build. none: checked, already current.
 */
export const UPDATE_STATUSES = ['off', 'unsupported', 'idle', 'checking', 'available', 'downloading', 'ready', 'none', 'error'] as const;
export const UpdateStatusSchema = z.enum(UPDATE_STATUSES);
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

export const UpdateStateSchema = z.object({
  status: UpdateStatusSchema,
  /** Version on offer (available / downloading / ready). */
  version: z.string().nullable(),
  /** 0–100 while downloading. */
  progress: z.number().min(0).max(100).nullable(),
  message: z.string().nullable(),
  checkedAt: z.number().int().nullable()
});
export type UpdateState = z.infer<typeof UpdateStateSchema>;

export const ClearHistoryResultSchema = z.object({ removed: z.number().int().nonnegative(), worktreesKept: z.number().int().nonnegative() });
export type ClearHistoryResult = z.infer<typeof ClearHistoryResultSchema>;
