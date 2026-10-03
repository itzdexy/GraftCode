import { z } from 'zod';
import { AppSettingsSchema } from './appSettings';
import { ProviderSummarySchema } from './models';

export const EnvironmentInfoSchema = z.object({
  platform: z.enum(['win32', 'darwin', 'linux']),
  git: z.object({ available: z.boolean(), version: z.string().nullable() }),
  shell: z.object({ kind: z.string(), label: z.string(), path: z.string() }),
  ripgrep: z.boolean(),
  keyring: z.boolean(),
  gh: z.boolean()
});
export type EnvironmentInfo = z.infer<typeof EnvironmentInfoSchema>;

export const BootstrapSchema = z.object({
  /** True until onboarding is finished. */
  firstRun: z.boolean(),
  settings: AppSettingsSchema,
  providers: z.array(ProviderSummarySchema),
  environment: EnvironmentInfoSchema,
  paths: z.object({ userData: z.string(), graftHome: z.string() }),
  version: z.string()
});
export type Bootstrap = z.infer<typeof BootstrapSchema>;

export const ProjectSummarySchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  trusted: z.boolean(),
  exists: z.boolean(),
  lastUsedAt: z.number().int(),
  settings: z.object({
    model: z.object({ providerId: z.string(), modelId: z.string() }).optional(),
    effort: z.string().optional(),
    permissionMode: z.string().optional(),
    useWorktree: z.boolean().optional(),
    sandbox: z.boolean().optional()
  })
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const SearchResultSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  kind: z.enum(['chat', 'code']),
  projectName: z.string().nullable(),
  snippet: z.string(),
  updatedAt: z.number().int()
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SlashCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string().nullable(),
  source: z.enum(['builtin', 'user', 'project']),
  path: z.string().nullable()
});
export type SlashCommand = z.infer<typeof SlashCommandSchema>;

export const DiffStatsSchema = z.object({
  added: z.number().int(),
  removed: z.number().int(),
  files: z.number().int(),
  base: z.string().nullable(),
  branch: z.string().nullable()
});
export type DiffStatsView = z.infer<typeof DiffStatsSchema>;

export const BranchListSchema = z.object({
  isRepo: z.boolean(),
  current: z.string().nullable(),
  branches: z.array(z.object({ name: z.string(), current: z.boolean(), remote: z.boolean() }))
});
export type BranchList = z.infer<typeof BranchListSchema>;
