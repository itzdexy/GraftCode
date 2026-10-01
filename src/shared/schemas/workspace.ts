import { z } from 'zod';
import { EffortLevelSchema, PermissionModeSchema } from './common';

/** Artifacts and scheduled sessions. */

export const ArtifactSchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.enum(['html', 'image', 'markdown', 'code', 'other']),
  sessionId: z.string(),
  sessionTitle: z.string(),
  projectName: z.string().nullable(),
  created: z.boolean(),
  updatedAt: z.number().int(),
  exists: z.boolean(),
  size: z.number().int().nullable()
});
export type ArtifactView = z.infer<typeof ArtifactSchema>;

export const ArtifactTextSchema = z.object({ content: z.string().nullable(), binary: z.boolean(), tooLarge: z.boolean() });

export const ScheduleSchema = z.object({
  id: z.string(),
  name: z.string(),
  cron: z.string(),
  description: z.string(),
  prompt: z.string(),
  projectPath: z.string(),
  providerId: z.string().nullable(),
  modelId: z.string().nullable(),
  effort: EffortLevelSchema.nullable(),
  permissionMode: PermissionModeSchema,
  enabled: z.boolean(),
  lastRunAt: z.number().int().nullable(),
  nextRunAt: z.number().int().nullable(),
  createdAt: z.number().int()
});
export type ScheduleView = z.infer<typeof ScheduleSchema>;

export const ScheduleRunSchema = z.object({
  id: z.string(),
  scheduleId: z.string(),
  sessionId: z.string().nullable(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  status: z.enum(['running', 'waiting', 'completed', 'failed']),
  error: z.string().nullable()
});
export type ScheduleRunView = z.infer<typeof ScheduleRunSchema>;

export const ScheduleInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  cron: z.string().trim().min(9).max(200),
  prompt: z.string().trim().min(1).max(20_000),
  projectPath: z.string().min(1).max(4096),
  providerId: z.string().max(200).nullable(),
  modelId: z.string().max(300).nullable(),
  effort: EffortLevelSchema.nullable(),
  permissionMode: PermissionModeSchema,
  enabled: z.boolean()
});
export type ScheduleInputView = z.infer<typeof ScheduleInputSchema>;
