import { z } from 'zod';
import { AppSettingsPatchSchema, AppSettingsSchema, AvatarDataUrlSchema, NicknameSchema, SEARCH_ENGINE_IDS } from '../schemas/appSettings';
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
import { HooksConfigSchema, SettingsScopeSchema } from '../schemas/config';
import { ArtifactSchema, ArtifactTextSchema, ScheduleInputSchema, ScheduleRunSchema, ScheduleSchema } from '../schemas/workspace';
import {
  AgentFileSchema,
  CommandFileSchema,
  CustomScopeSchema,
  McpServerInputSchema,
  McpServerNameSchema,
  McpServerViewSchema,
  MemoryInfoSchema,
  ScopedHooksSchema,
  SkillFileSchema
} from '../schemas/customize';
import { BackgroundShellSchema, BoundsSchema, FilePreviewSchema, TerminalInfoSchema, TreeEntrySchema } from '../schemas/panels';
import { FileAttachmentSchema, ImageBlockSchema } from '../schemas/messages';
import { CustomModelSchema, ModelInfoSchema, ProviderPresetSchema, ProviderSummarySchema, VerifyResultSchema } from '../schemas/models';
import { PermissionResponseSchema, QuestionResponseSchema } from '../schemas/permissions';
import { RewindModeSchema, RewindPreviewSchema, RewindResultSchema } from '../schemas/rewind';
import { SessionDetailSchema, SessionKindSchema, SessionSummarySchema } from '../schemas/sessions';
import { ClearHistoryResultSchema, RuleListsSchema, ScopedRulesSchema, UpdateStateSchema } from '../schemas/system';

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
  versions: z.object({ electron: z.string(), chrome: z.string(), node: z.string() }),
  /** Folder holding the database, logs and window state. */
  dataDir: z.string(),
  /** The page where installed builds can download releases by hand; null when the feed has none. */
  releasesUrl: z.string().nullable()
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

const PathSchema = z.string().min(1).max(4096);
const Void = z.void();
const Ok = z.object({ ok: z.literal(true) });

export const SearchStatusSchema = z.object({
  /** The engine searches use now (null: none is set up, or search is off). */
  active: z.enum(SEARCH_ENGINE_IDS).nullable(),
  /** Which engines have a stored key; the keys themselves never leave the main process. */
  keys: z.object({ brave: z.boolean(), tavily: z.boolean() }),
  /** Providers whose own search is available (a key on the vendor's endpoint). */
  providers: z.object({ openrouter: z.boolean(), anthropic: z.boolean(), openai: z.boolean(), gemini: z.boolean() })
});
export type SearchStatus = z.infer<typeof SearchStatusSchema>;

export const SpeechModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  voices: z.array(z.string()),
  /** USD per 1,000 characters of text, when known. */
  pricePer1kChars: z.number().nullable(),
  /** Also bills the audio it makes. */
  billsOutput: z.boolean()
});
export type SpeechModel = z.infer<typeof SpeechModelSchema>;

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
  message: z
    .object({ text: z.string().max(200_000), images: z.array(ImageBlockSchema).max(20), files: z.array(FileAttachmentSchema).max(10).default([]) })
    .nullable()
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
  // Web search engines and site icons
  'search:status': channel(Void, SearchStatusSchema),
  'search:setKey': channel(z.object({ engine: z.enum(['brave', 'tavily']), key: z.string().trim().min(8).max(300).nullable() }), SearchStatusSchema),
  'search:test': channel(Void, z.object({ engine: z.enum(SEARCH_ENGINE_IDS), count: z.number().int(), first: z.object({ title: z.string(), url: z.string() }).nullable() })),
  /** Natural voices: whether an OpenRouter key is set up, and the speech models it offers. */
  'voice:models': channel(Void, z.object({ available: z.boolean(), models: z.array(SpeechModelSchema) })),
  /** MP3 audio (base64) for a piece of a reply; the OpenRouter key stays in the main process. */
  'voice:speak': channel(
    z.object({ text: z.string().min(1).max(5000), model: z.string().min(1).max(200), voice: z.string().min(1).max(200), speed: z.number().min(0.5).max(2) }),
    z.object({ audio: z.string(), mime: z.string() })
  ),
  'web:favicon': channel(z.object({ host: z.string().min(3).max(253) }), z.string().nullable()),
  'power:keepAwake': channel(z.object({ sessionId: IdSchema, on: z.boolean() }), z.object({ on: z.boolean() })),
  'power:keepAwakeList': channel(Void, z.array(z.string())),
  /** Colours are the palette's --g-bg and --g-icon; without them the theme's default colours apply. */
  'window:setTitlebarTheme': channel(
    z.object({
      theme: ResolvedThemeSchema,
      colors: z.object({ background: z.string().regex(/^#[0-9a-f]{6}$/i), symbol: z.string().regex(/^#[0-9a-f]{6}$/i) }).optional()
    }),
    Void
  ),
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
  'providers:presets': channel(Void, z.array(ProviderPresetSchema)),
  'providers:verify': channel(
    z.object({
      kind: ProviderKindSchema,
      preset: z.string().max(100).nullable().default(null),
      baseUrl: z.string().max(2048).nullable(),
      apiKey: z.string().max(4096).nullable()
    }),
    VerifyResultSchema
  ),
  'providers:add': channel(
    z.object({
      kind: ProviderKindSchema,
      preset: z.string().max(100).nullable().default(null),
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
    z.object({ id: IdSchema, text: z.string().max(200_000), images: z.array(ImageBlockSchema).max(20), files: z.array(FileAttachmentSchema).max(10).default([]) }),
    z.object({ queued: z.boolean() })
  ),
  'sessions:interrupt': channel(z.object({ id: IdSchema }), Ok),
  /** A command typed after "!" in a code session's message box; it runs in the session's shell. */
  'sessions:shell': channel(z.object({ id: IdSchema, command: z.string().min(1).max(20_000) }), Ok),
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
  /** Files a chat made: save a copy (null when cancelled), open it in its viewer, or show it in its folder. */
  'chatFiles:save': channel(z.object({ sessionId: IdSchema, name: z.string().min(1).max(200) }), z.string().nullable()),
  'chatFiles:open': channel(z.object({ sessionId: IdSchema, name: z.string().min(1).max(200) }), Void),
  'chatFiles:reveal': channel(z.object({ sessionId: IdSchema, name: z.string().min(1).max(200) }), Void),
  'sessions:retry': channel(z.object({ id: IdSchema }), Ok),
  'sessions:regenerate': channel(z.object({ id: IdSchema }), Ok),
  'sessions:compact': channel(z.object({ id: IdSchema, instructions: z.string().max(4000) }), Ok),
  /** The system prompt and tool names the session's next turn sends (Session → View system prompt). */
  'sessions:systemPrompt': channel(z.object({ id: IdSchema }), z.object({ system: z.string(), tools: z.array(z.string()), model: z.string() })),
  'sessions:removeQueued': channel(z.object({ id: IdSchema, queueId: IdSchema }), Ok),
  /** "Send now": a queued message reaches the agent after its next tool step instead of after the turn. */
  'sessions:steer': channel(z.object({ id: IdSchema, queueId: IdSchema }), Ok),
  'sessions:markRead': channel(z.object({ id: IdSchema }), Ok),
  'sessions:setActive': channel(z.object({ id: IdSchema.nullable() }), Ok),
  'sessions:feedback': channel(z.object({ sessionId: IdSchema, messageId: IdSchema, value: z.union([z.literal(-1), z.literal(0), z.literal(1)]) }), Ok),
  'sessions:rewindPreview': channel(z.object({ sessionId: IdSchema, messageId: IdSchema }), RewindPreviewSchema),
  'sessions:rewind': channel(z.object({ sessionId: IdSchema, messageId: IdSchema, mode: RewindModeSchema }), RewindResultSchema),
  'search:query': channel(z.object({ query: z.string().max(200), kind: SessionKindSchema.nullable() }), z.array(SearchResultSchema)),
  'commands:list': channel(z.object({ projectPath: PathSchema.nullable() }), z.array(SlashCommandSchema)),
  'files:search': channel(z.object({ root: PathSchema, query: z.string().max(300) }), z.array(z.string())),

  // Side panels
  'files:list': channel(z.object({ sessionId: IdSchema, dir: z.string().max(4096) }), z.array(TreeEntrySchema)),
  'files:read': channel(z.object({ sessionId: IdSchema, path: PathSchema }), FilePreviewSchema),
  'pty:create': channel(
    z.object({ sessionId: IdSchema, cols: z.number().int().min(2).max(1000), rows: z.number().int().min(1).max(500) }),
    TerminalInfoSchema
  ),
  'pty:list': channel(z.object({ sessionId: IdSchema }), z.array(TerminalInfoSchema)),
  'pty:snapshot': channel(z.object({ id: IdSchema }), z.object({ data: z.string(), end: z.number().int() })),
  'pty:write': channel(z.object({ id: IdSchema, data: z.string().max(100_000) }), Void),
  'pty:resize': channel(z.object({ id: IdSchema, cols: z.number().int().min(2).max(1000), rows: z.number().int().min(1).max(500) }), Void),
  'pty:kill': channel(z.object({ id: IdSchema }), Ok),
  'shells:list': channel(z.object({ sessionId: IdSchema }), z.array(BackgroundShellSchema)),
  'shells:output': channel(z.object({ id: IdSchema }), z.object({ output: z.string(), skipped: z.number().int() })),
  'shells:kill': channel(z.object({ id: IdSchema }), z.object({ killed: z.boolean() })),
  'shells:clear': channel(z.object({ sessionId: IdSchema }), z.object({ removed: z.number().int() })),
  'browser:navigate': channel(z.object({ url: z.string().min(1).max(4096) }), z.object({ url: z.string() })),
  'browser:bounds': channel(z.object({ bounds: BoundsSchema.nullable() }), Void),
  'browser:command': channel(z.object({ command: z.enum(['back', 'forward', 'reload', 'stop', 'close', 'external']) }), Void),

  // Customize
  'customize:commands': channel(z.object({ projectPath: PathSchema.nullable() }), z.array(CommandFileSchema)),
  'customize:saveCommand': channel(
    z.object({
      scope: CustomScopeSchema,
      projectPath: PathSchema.nullable(),
      name: z.string().min(1).max(64),
      description: z.string().max(300),
      argumentHint: z.string().max(120).nullable(),
      body: z.string().max(200_000),
      previousPath: PathSchema.nullable()
    }),
    z.object({ path: z.string() })
  ),
  'customize:deleteCommand': channel(z.object({ projectPath: PathSchema.nullable(), path: PathSchema }), Ok),
  'customize:agents': channel(z.object({ projectPath: PathSchema.nullable() }), z.array(AgentFileSchema)),
  'customize:saveAgent': channel(
    z.object({
      scope: CustomScopeSchema,
      projectPath: PathSchema.nullable(),
      name: z.string().min(1).max(64),
      description: z.string().max(300),
      tools: z.array(z.string().min(1).max(128)).max(64).nullable(),
      body: z.string().max(200_000),
      previousPath: PathSchema.nullable()
    }),
    z.object({ path: z.string() })
  ),
  'customize:deleteAgent': channel(z.object({ projectPath: PathSchema.nullable(), path: PathSchema }), Ok),
  /** Tool names a custom agent can choose from (built-ins of code sessions). */
  'customize:agentTools': channel(Void, z.array(z.string())),
  'customize:skills': channel(z.object({ projectPath: PathSchema.nullable() }), z.array(SkillFileSchema)),
  'customize:saveSkill': channel(
    z.object({
      scope: CustomScopeSchema,
      projectPath: PathSchema.nullable(),
      name: z.string().min(1).max(64),
      description: z.string().max(500),
      body: z.string().max(200_000),
      previousPath: PathSchema.nullable()
    }),
    z.object({ path: z.string() })
  ),
  'customize:deleteSkill': channel(z.object({ projectPath: PathSchema.nullable(), path: PathSchema }), Ok),
  'customize:memory': channel(z.object({ projectPath: PathSchema.nullable() }), z.array(MemoryInfoSchema)),
  'customize:saveMemory': channel(z.object({ scope: CustomScopeSchema, projectPath: PathSchema.nullable(), content: z.string().max(200_000) }), z.object({ path: z.string() })),
  'customize:hooks': channel(z.object({ projectPath: PathSchema.nullable() }), z.array(ScopedHooksSchema)),
  'customize:saveHooks': channel(z.object({ scope: SettingsScopeSchema, projectPath: PathSchema.nullable(), hooks: HooksConfigSchema }), Ok),
  'mcp:list': channel(z.object({ projectPath: PathSchema.nullable() }), z.array(McpServerViewSchema)),
  'mcp:save': channel(
    z.object({ scope: SettingsScopeSchema, projectPath: PathSchema.nullable(), name: McpServerNameSchema, previousName: McpServerNameSchema.nullable(), config: McpServerInputSchema }),
    Ok
  ),
  'mcp:remove': channel(z.object({ scope: SettingsScopeSchema, projectPath: PathSchema.nullable(), name: McpServerNameSchema }), Ok),
  'mcp:setEnabled': channel(z.object({ scope: SettingsScopeSchema, projectPath: PathSchema.nullable(), name: McpServerNameSchema, enabled: z.boolean() }), Ok),
  'mcp:reconnect': channel(z.object({ name: McpServerNameSchema }), Ok),
  'mcp:authorize': channel(z.object({ name: McpServerNameSchema }), Ok),

  // Artifacts & schedules
  'artifacts:list': channel(Void, z.array(ArtifactSchema)),
  'artifacts:read': channel(z.object({ path: PathSchema }), ArtifactTextSchema),
  'artifacts:previewUrl': channel(z.object({ path: PathSchema }), z.object({ url: z.string() })),
  'schedules:list': channel(Void, z.array(ScheduleSchema)),
  'schedules:save': channel(z.object({ id: IdSchema.nullable(), schedule: ScheduleInputSchema }), ScheduleSchema),
  'schedules:setEnabled': channel(z.object({ id: IdSchema, enabled: z.boolean() }), ScheduleSchema),
  'schedules:delete': channel(z.object({ id: IdSchema }), Ok),
  'schedules:runNow': channel(z.object({ id: IdSchema }), ScheduleRunSchema),
  'schedules:runs': channel(z.object({ id: IdSchema }), z.array(ScheduleRunSchema)),
  'schedules:describe': channel(z.object({ cron: z.string().max(200) }), z.object({ description: z.string(), next: z.number().int().nullable(), error: z.string().nullable() })),

  // Settings: permission rules, notifications, data, updates
  'permissions:get': channel(z.object({ projectPath: PathSchema.nullable() }), z.array(ScopedRulesSchema)),
  'permissions:save': channel(z.object({ scope: SettingsScopeSchema, projectPath: PathSchema.nullable(), rules: RuleListsSchema }), Ok),
  'notifications:test': channel(Void, z.object({ shown: z.boolean() })),
  'data:export': channel(Void, z.object({ path: z.string(), sessions: z.number().int() }).nullable()),
  'data:clearHistory': channel(Void, ClearHistoryResultSchema),
  'data:openFolder': channel(Void, Void),
  'updates:state': channel(Void, UpdateStateSchema),
  'updates:check': channel(Void, UpdateStateSchema),
  'updates:install': channel(Void, Ok)
};

export type Contracts = typeof contracts;
export type Channel = keyof Contracts;
export type ChannelInput<C extends Channel> = z.input<Contracts[C]['input']>;
export type ChannelParsedInput<C extends Channel> = z.output<Contracts[C]['input']>;
export type ChannelOutput<C extends Channel> = z.output<Contracts[C]['output']>;
