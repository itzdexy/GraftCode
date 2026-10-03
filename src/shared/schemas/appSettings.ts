import { z } from 'zod';
import { EffortLevelSchema, ModelRefSchema, PermissionModeSchema, RECOMMENDED_EFFORT } from './common';

export const NicknameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name.')
  .max(40, 'Keep it under 40 characters.')
  .refine((v) => ![...v].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127), 'Remove control characters.');

/** Downscaled avatar stored as a data URL (PNG/JPEG/WebP, ≤ 256 KB). */
export const AvatarDataUrlSchema = z
  .string()
  .max(360_000)
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, 'Unsupported image data');

export const SHORTCUT_IDS = [
  'newSession',
  'search',
  'toggleSidebar',
  'toggleTerminal',
  'toggleChanges',
  'focusComposer',
  'interrupt',
  'cyclePermissionMode',
  'openSettings',
  'toggleFiles'
] as const;
export const ShortcutIdSchema = z.enum(SHORTCUT_IDS);
export type ShortcutId = z.infer<typeof ShortcutIdSchema>;

export const DEFAULT_SHORTCUTS: Record<ShortcutId, string> = {
  newSession: 'Ctrl+N',
  search: 'Ctrl+K',
  toggleSidebar: 'Ctrl+B',
  toggleTerminal: 'Ctrl+`',
  toggleChanges: 'Ctrl+Shift+D',
  focusComposer: 'Ctrl+L',
  interrupt: 'Escape',
  cyclePermissionMode: 'Shift+Tab',
  openSettings: 'Ctrl+,',
  toggleFiles: 'Ctrl+Shift+F'
};

/** Engines the WebSearch tool can use (Settings → Web search). */
export const SEARCH_ENGINE_IDS = ['exa', 'duckduckgo', 'openrouter', 'anthropic', 'openai', 'gemini', 'brave', 'tavily', 'searxng'] as const;
export type SearchEngineId = (typeof SEARCH_ENGINE_IDS)[number];
export const SearchEngineSettingSchema = z.enum(['auto', ...SEARCH_ENGINE_IDS, 'off']);
export type SearchEngineSetting = z.infer<typeof SearchEngineSettingSchema>;

export const OnboardingStepSchema = z.enum(['name', 'avatar', 'provider', 'key', 'defaults', 'done']);
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;

export const AppSettingsSchema = z.object({
  profile: z.object({ name: z.string().max(40), avatar: AvatarDataUrlSchema.nullable() }),
  onboarding: z.object({
    step: OnboardingStepSchema,
    /** Provider chosen on the provider step, carried to the key step. */
    providerKind: z.string().nullable(),
    /** Catalog preset chosen with it (null for a custom endpoint). */
    providerPreset: z.string().nullable(),
    providerId: z.string().nullable()
  }),
  appearance: z.object({
    theme: z.enum(['system', 'dark', 'light']),
    uiFontSize: z.number().int().min(11).max(18),
    codeFontSize: z.number().int().min(10).max(20),
    reducedMotion: z.boolean(),
    /** Width of the transcript and composer column. */
    transcriptWidth: z.enum(['narrow', 'medium', 'wide'])
  }),
  defaults: z.object({
    model: ModelRefSchema.nullable(),
    effort: EffortLevelSchema,
    permissionMode: PermissionModeSchema,
    useWorktree: z.boolean(),
    lastProjectPath: z.string().nullable()
  }),
  notifications: z.object({
    enabled: z.boolean(),
    needsInput: z.boolean(),
    finished: z.boolean(),
    errors: z.boolean()
  }),
  behavior: z.object({
    runInTray: z.boolean(),
    bypassModeEnabled: z.boolean(),
    /** Bypass still asks before dangerous commands, writes outside the project and config changes. */
    bypassKeepsChecks: z.boolean(),
    autoCompact: z.boolean(),
    webSearch: z.boolean(),
    /** Code sessions may see the screen and use the mouse and keyboard (asks before each action). */
    computerUse: z.boolean()
  }),
  security: z.object({ allowPlaintextKeys: z.boolean() }),
  privacy: z.object({
    /** Ask providers not to train on or keep requests (OpenRouter then skips providers that do). */
    noTraining: z.boolean(),
    /** Incognito chats refuse models that aren't served from this computer. */
    incognitoLocalOnly: z.boolean()
  }),
  updates: z.object({ enabled: z.boolean() }),
  search: z.object({
    /** Engine for the WebSearch tool; "auto" picks the first one that is set up. */
    engine: SearchEngineSettingSchema,
    /** A SearXNG instance with its JSON API on. */
    searxngUrl: z.url({ protocol: /^https?$/ }).max(500).nullable()
  }),
  /** Read aloud: a natural voice from OpenRouter's speech models, or this computer's own voices. */
  voice: z.object({
    engine: z.enum(['natural', 'system']),
    /** OpenRouter speech model and one of its voices. */
    model: z.string().min(1).max(200),
    voice: z.string().min(1).max(200),
    /** One of this computer's voices by name; null picks the best one available. */
    systemVoice: z.string().max(200).nullable(),
    speed: z.number().min(0.5).max(2)
  }),
  shortcuts: z.record(ShortcutIdSchema, z.string().max(40)),
  ui: z.object({
    sidebarWidth: z.number().int().min(200).max(480),
    sidebarCollapsed: z.boolean(),
    mode: z.enum(['chat', 'code']),
    dismissedTips: z.array(z.string().max(80)).max(200)
  })
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  profile: { name: '', avatar: null },
  onboarding: { step: 'name', providerKind: null, providerPreset: null, providerId: null },
  appearance: { theme: 'system', uiFontSize: 13, codeFontSize: 13, reducedMotion: false, transcriptWidth: 'narrow' },
  defaults: { model: null, effort: RECOMMENDED_EFFORT, permissionMode: 'ask', useWorktree: false, lastProjectPath: null },
  notifications: { enabled: true, needsInput: true, finished: true, errors: true },
  behavior: { runInTray: false, bypassModeEnabled: false, bypassKeepsChecks: false, autoCompact: true, webSearch: true, computerUse: false },
  security: { allowPlaintextKeys: false },
  privacy: { noTraining: true, incognitoLocalOnly: false },
  updates: { enabled: true },
  search: { engine: 'auto', searxngUrl: null },
  voice: { engine: 'natural', model: 'hexgrad/kokoro-82m', voice: 'af_heart', systemVoice: null, speed: 1 },
  shortcuts: { ...DEFAULT_SHORTCUTS },
  ui: { sidebarWidth: 262, sidebarCollapsed: false, mode: 'code', dismissedTips: [] }
};

export type AppSettingsSection = keyof AppSettings;
export const APP_SETTINGS_SECTIONS = Object.keys(DEFAULT_APP_SETTINGS) as AppSettingsSection[];

/** Partial update: any subset of sections, each a partial of that section. */
export const AppSettingsPatchSchema = z.object({
  profile: AppSettingsSchema.shape.profile.partial().optional(),
  onboarding: AppSettingsSchema.shape.onboarding.partial().optional(),
  appearance: AppSettingsSchema.shape.appearance.partial().optional(),
  defaults: AppSettingsSchema.shape.defaults.partial().optional(),
  notifications: AppSettingsSchema.shape.notifications.partial().optional(),
  behavior: AppSettingsSchema.shape.behavior.partial().optional(),
  security: AppSettingsSchema.shape.security.partial().optional(),
  privacy: AppSettingsSchema.shape.privacy.partial().optional(),
  updates: AppSettingsSchema.shape.updates.partial().optional(),
  search: AppSettingsSchema.shape.search.partial().optional(),
  voice: AppSettingsSchema.shape.voice.partial().optional(),
  shortcuts: z.partialRecord(ShortcutIdSchema, z.string().max(40)).optional(),
  ui: AppSettingsSchema.shape.ui.partial().optional()
});
export type AppSettingsPatch = z.infer<typeof AppSettingsPatchSchema>;
