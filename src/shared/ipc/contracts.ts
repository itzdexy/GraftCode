import { z } from 'zod';
import { AppSettingsPatchSchema, AppSettingsSchema, AvatarDataUrlSchema, NicknameSchema } from '../schemas/appSettings';
import {
  BootstrapSchema,
  BranchListSchema,
  DiffStatsSchema,
  EnvironmentInfoSchema,
  ProjectSummarySchema,
  SearchResultSchema,
  SlashCommandSchema
} from '../schemas/app';
import { EffortLevelSchema, IdSchema, ModelRefSchema, PermissionModeSchema, ProviderKindSchema } from '../schemas/common';
import { FileDiffSchema, GitStatusSchema, PullRequestResultSchema } from '../schemas/git';
import { ImageBlockSchema } from '../schemas/messages';
import { CustomModelSchema, ModelInfoSchema, ProviderSummarySchema, VerifyResultSchema } from '../schemas/models';
import { PermissionResponseSchema, QuestionResponseSchema } from '../schemas/permissions';
import { RewindModeSchema, RewindPreviewSchema, RewindResultSchema } from '../schemas/rewind';
import { SessionDetailSchema, SessionKindSchema, SessionSummarySchema } from '../schemas/sessions';

/**
 * Every renderer → main request, with Zod schemas for input and output.
 * Main validates input before a handler runs; the renderer imports types only.
 */
export const ThemePreferenceSchema = z.enum(['dark', 'light', 'system']);
export type ThemePreference = z.infer<typeof ThemePreferenceSchema>;
export const ResolvedThemeSchema = z.enum(['dark', 'light']);
export type ResolvedTheme = z.infer<typeof ResolvedThemeSchema>;
export const PlatformSchema = z.enum(['win32', 'darwin', 'linux']);
export type Platform = z.infer<typeof PlatformSchema>;

export const AppInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  platform: PlatformSchema,
  isPackaged: z.boolean(),
  versions: z.object({ electron: z.string(), chrome: z.string(), node: z.string() })
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

const PathSchema = z.string().min(1).max(4096);
const Void = z.void();
const Ok = z.object({ ok: z.literal(true) });

export const ProviderModelsSchema = z.object({
  providerId: z.string(),
  models: z.array(ModelInfoSchema),
  error: z.object({ code: z.string(), message: z.string() }).nullable()
});

export const CreateSessionInputSchema = z.object({
  kind: SessionKindSchema,
  projectPath: PathSchema.nullable(),
  useWorktree: z.boolean(),
  branch: z.string().max(255).nullable(),
  model: ModelRefSchema.nullable(),
  effort: EffortLevelSchema.nullable(),
  permissionMode: PermissionModeSchema.nullable(),
  incognito: z.boolean(),
  message: z.object({ text: z.string().max(200_000), images: z.array(ImageBlockSchema).max(20) }).nullable()
});
export type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>;

const channel = <I extends z.ZodType, O extends z.ZodType>(input: I, output: O) => ({ input, output });

export const contracts = {
  // App & window
  'app:info': channel(Void, AppInfoSchema),
  'app:bootstrap': channel(Void, BootstrapSchema),
  'app:environment': channel(Void, EnvironmentInfoSchema),
  'app:openExternal': channel(z.object({ url: z.string().max(4096) }), Void),
  'app:revealPath': channel(z.object({ path: PathSchema }), Void),
  'app:quickSplash': channel(Void, z.boolean()),
  'app:log': channel(
    z.object({ level: z.enum(['warn', 'error']), message: z.string().max(4000), stack: z.string().max(8000).optional() }),
    Void
  ),
  'window:setTitlebarTheme': channel(z.object({ theme: ResolvedThemeSchema }), Void),
  'dialog:pickFolder': channel(z.object({ title: z.string().max(200).optional() }), z.string().nullable()),
  'app:openInEditor': channel(z.object({ path: PathSchema }), z.object({ via: z.enum(['editor', 'folder']) })),

  // Settings & onboarding
  'settings:get': channel(Void, AppSettingsSchema),
  'settings:update': channel(AppSettingsPatchSchema, AppSettingsSchema),
  'profile:update': channel(z.object({ name: NicknameSchema.optional(), avatar: AvatarDataUrlSchema.nullable().optional() }), AppSettingsSchema),
  'onboarding:complete': channel(
    z.object({ model: ModelRefSchema, effort: EffortLevelSchema, projectPath: PathSchema.nullable() }),
    AppSettingsSchema
  ),
  'onboarding:reset': channel(Void, AppSettingsSchema),

  // Providers & models
  'providers:list': channel(Void, z.array(ProviderSummarySchema)),
  'providers:verify': channel(
    z.object({ kind: ProviderKindSchema, baseUrl: z.string().max(2048).nullable(), apiKey: z.string().max(4096).nullable() }),
    VerifyResultSchema
  ),
  'providers:add': channel(
    z.object({
      kind: ProviderKindSchema,
      label: z.string().min(1).max(80).nullable(),
      baseUrl: z.string().max(2048).nullable(),
      apiKey: z.string().max(4096).nullable()
    }),
    ProviderSummarySchema
  ),
  'providers:update': channel(
    z.object({
      id: IdSchema,
      label: z.string().min(1).max(80).optional(),
      baseUrl: z.string().max(2048).nullable().optional(),
      apiKey: z.string().min(1).max(4096).optional(),
      enabled: z.boolean().optional(),
      customModels: z.array(CustomModelSchema).max(200).optional()
    }),
    ProviderSummarySchema
  ),
  'providers:remove': channel(z.object({ id: IdSchema }), Ok),
  'providers:setDefault': channel(z.object({ id: IdSchema }), Ok),
  'providers:test': channel(z.object({ id: IdSchema }), VerifyResultSchema),
  'models:list': channel(z.object({ refresh: z.boolean() }), z.array(ProviderModelsSchema)),
  'secrets:status': channel(Void, z.object({ encryptionAvailable: z.boolean(), plaintextAllowed: z.boolean() })),

  // Projects & git info
  'projects:list': channel(Void, z.array(ProjectSummarySchema)),
  'projects:add': channel(z.object({ path: PathSchema }), ProjectSummarySchema),
  'projects:update': channel(
    z.object({
      id: IdSchema,
      name: z.string().min(1).max(120).optional(),
      trusted: z.boolean().optional(),
      settings: ProjectSummarySchema.shape.settings.optional()
    }),
    ProjectSummarySchema
  ),
  'projects:remove': channel(z.object({ id: IdSchema }), Ok),
  'git:branches': channel(z.object({ path: PathSchema }), BranchListSchema),
  'git:diffStats': channel(z.object({ sessionId: IdSchema }), DiffStatsSchema),
  'git:status': channel(z.object({ sessionId: IdSchema }), GitStatusSchema),
  'git:fileDiff': channel(z.object({ sessionId: IdSchema, path: PathSchema, staged: z.boolean() }), FileDiffSchema),
  'git:stage': channel(z.object({ sessionId: IdSchema, paths: z.array(PathSchema).min(1).max(5000) }), Ok),
  'git:unstage': channel(z.object({ sessionId: IdSchema, paths: z.array(PathSchema).min(1).max(5000) }), Ok),
  /** Discards working-tree changes. Destructive: the renderer confirms with the user first. */
  'git:revert': channel(z.object({ sessionId: IdSchema, paths: z.array(PathSchema).min(1).max(5000) }), Ok),
  'git:hunk': channel(
    z.object({ sessionId: IdSchema, path: PathSchema, index: z.number().int().min(0), action: z.enum(['stage', 'unstage', 'revert']) }),
    Ok
  ),
  'git:commit': channel(z.object({ sessionId: IdSchema, message: z.string().min(1).max(20_000), stageAll: z.boolean() }), z.object({ sha: z.string() })),
  'git:push': channel(z.object({ sessionId: IdSchema }), z.object({ branch: z.string() })),
  'git:createPr': channel(z.object({ sessionId: IdSchema }), PullRequestResultSchema),
  'git:suggestCommitMessage': channel(z.object({ sessionId: IdSchema }), z.object({ message: z.string() })),

  // Sessions
  'sessions:list': channel(z.object({ includeArchived: z.boolean() }), z.array(SessionSummarySchema)),
  'sessions:create': channel(CreateSessionInputSchema, SessionSummarySchema),
  'sessions:get': channel(z.object({ id: IdSchema }), SessionDetailSchema),
  'sessions:send': channel(
    z.object({ id: IdSchema, text: z.string().max(200_000), images: z.array(ImageBlockSchema).max(20) }),
    z.object({ queued: z.boolean() })
  ),
  'sessions:interrupt': channel(z.object({ id: IdSchema }), Ok),
  'sessions:respondPermission': channel(PermissionResponseSchema.extend({ sessionId: IdSchema }), Ok),
  'sessions:answerQuestion': channel(QuestionResponseSchema.extend({ sessionId: IdSchema }), Ok),
  'sessions:setMode': channel(z.object({ id: IdSchema, mode: PermissionModeSchema }), Ok),
  'sessions:cycleMode': channel(z.object({ id: IdSchema }), PermissionModeSchema),
  'sessions:setModel': channel(z.object({ id: IdSchema, model: ModelRefSchema, effort: EffortLevelSchema.nullable() }), Ok),
  'sessions:rename': channel(z.object({ id: IdSchema, title: z.string().trim().min(1).max(200) }), Ok),
  'sessions:setPinned': channel(z.object({ id: IdSchema, pinned: z.boolean() }), Ok),
  'sessions:archive': channel(
    z.object({ id: IdSchema, archived: z.boolean(), removeWorktree: z.boolean(), force: z.boolean() }),
    z.object({ branchKeptReason: z.string().nullable() })
  ),
  'sessions:delete': channel(z.object({ id: IdSchema, force: z.boolean() }), Ok),
  'sessions:duplicate': channel(z.object({ id: IdSchema }), SessionSummarySchema),
  'sessions:export': channel(z.object({ id: IdSchema, format: z.enum(['markdown', 'json']) }), z.string().nullable()),
  'sessions:retry': channel(z.object({ id: IdSchema }), Ok),
  'sessions:regenerate': channel(z.object({ id: IdSchema }), Ok),
  'sessions:compact': channel(z.object({ id: IdSchema, instructions: z.string().max(4000) }), Ok),
  'sessions:removeQueued': channel(z.object({ id: IdSchema, queueId: IdSchema }), Ok),
  'sessions:markRead': channel(z.object({ id: IdSchema }), Ok),
  'sessions:setActive': channel(z.object({ id: IdSchema.nullable() }), Ok),
  'sessions:feedback': channel(z.object({ sessionId: IdSchema, messageId: IdSchema, value: z.union([z.literal(-1), z.literal(0), z.literal(1)]) }), Ok),
  'sessions:rewindPreview': channel(z.object({ sessionId: IdSchema, messageId: IdSchema }), RewindPreviewSchema),
  'sessions:rewind': channel(z.object({ sessionId: IdSchema, messageId: IdSchema, mode: RewindModeSchema }), RewindResultSchema),
  'search:query': channel(z.object({ query: z.string().max(200), kind: SessionKindSchema.nullable() }), z.array(SearchResultSchema)),
  'commands:list': channel(z.object({ projectPath: PathSchema.nullable() }), z.array(SlashCommandSchema)),
  'files:search': channel(z.object({ root: PathSchema, query: z.string().max(300) }), z.array(z.string()))
};

export type Contracts = typeof contracts;
export type Channel = keyof Contracts;
export type ChannelInput<C extends Channel> = z.input<Contracts[C]['input']>;
export type ChannelParsedInput<C extends Channel> = z.output<Contracts[C]['input']>;
export type ChannelOutput<C extends Channel> = z.output<Contracts[C]['output']>;
