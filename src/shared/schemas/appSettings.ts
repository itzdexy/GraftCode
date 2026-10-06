import { z } from 'zod';
import { EffortLevelSchema, ModelRefSchema, PermissionModeSchema, RECOMMENDED_EFFORT } from './common';
import { MODEL_ROLES, ModelRoleSchema, type ModelRoleId } from './agentRuns';

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
  'toggleFiles',
  'commandPalette'
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
  toggleFiles: 'Ctrl+Shift+F',
  commandPalette: 'Ctrl+Shift+P'
};

/** Settings → Appearance: colour palettes (generated in styles/palettes.css) and accent colours. */
export const PALETTE_IDS = ['graft', 'midnight', 'slate', 'grove', 'dune', 'contrast'] as const;
export type PaletteId = (typeof PALETTE_IDS)[number];
export const ACCENT_IDS = ['leaf', 'ocean', 'iris', 'rose', 'gold', 'teal', 'mono'] as const;
export type AccentId = (typeof ACCENT_IDS)[number];
/** Settings → Appearance → Motion. */
export const MOTION_SETTINGS = ['system', 'on', 'reduced'] as const;
export type MotionSetting = (typeof MOTION_SETTINGS)[number];

/** Settings → Personalization: how answers are written, in chats and code sessions. */
export const RESPONSE_STYLES = ['default', 'concise', 'explanatory', 'learning'] as const;
export const ResponseStyleSchema = z.enum(RESPONSE_STYLES);
export type ResponseStyle = z.infer<typeof ResponseStyleSchema>;
/** Longest "about you" and "how to respond" text. */
export const PERSONALIZATION_MAX = 3000;

/** Engines the WebSearch tool can use (Settings → Web search). */
export const SEARCH_ENGINE_IDS = ['exa', 'duckduckgo', 'openrouter', 'anthropic', 'openai', 'gemini', 'brave', 'tavily', 'searxng'] as const;
export type SearchEngineId = (typeof SEARCH_ENGINE_IDS)[number];
export const SearchEngineSettingSchema = z.enum(['auto', ...SEARCH_ENGINE_IDS, 'off']);
export type SearchEngineSetting = z.infer<typeof SearchEngineSettingSchema>;

/** Engines that can make pictures for the GenerateImage tool (Settings → Images). */
export const IMAGE_ENGINE_SETTINGS = ['auto', 'off', 'openrouter', 'openai', 'gemini', 'comfyui'] as const;
export type ImageEngineSetting = (typeof IMAGE_ENGINE_SETTINGS)[number];

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
    palette: z.enum(PALETTE_IDS),
    accent: z.enum(ACCENT_IDS),
    uiFontSize: z.number().int().min(11).max(18),
    codeFontSize: z.number().int().min(10).max(20),
    /** "system" follows the operating system's animation setting; "on" animates even when it asks for less. */
    motion: z.enum(MOTION_SETTINGS),
    /** Width of the transcript and composer column. */
    transcriptWidth: z.enum(['narrow', 'medium', 'wide'])
  }),
  defaults: z.object({
    model: ModelRefSchema.nullable(),
    /** Finishes a turn when the session's model keeps failing (overloaded, rate limited, unreachable); null for none. */
    fallbackModel: ModelRefSchema.nullable(),
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
    computerUse: z.boolean(),
    /** Pause a turn after this many model steps; null lets turns run until the work is done. */
    maxSteps: z.number().int().min(10).max(10_000).nullable()
  }),
  security: z.object({ allowPlaintextKeys: z.boolean() }),
  privacy: z.object({
    /** Ask providers not to train on or keep requests (OpenRouter then skips providers that do). */
    noTraining: z.boolean(),
    /** Incognito chats refuse models that aren't served from this computer. */
    incognitoLocalOnly: z.boolean()
  }),
  updates: z.object({ enabled: z.boolean() }),
  /** The container a project's commands run in when its sandbox is on. */
  sandbox: z.object({
    /** An image reference; never starting with "-" so it can't pass for a command-line flag. */
    image: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9._/:@-]{0,299}$/i, 'Use an image name like node:22-bookworm or ghcr.io/owner/image:tag'),
    /** Internet access for installs and downloads; off cuts the container off from every network. */
    network: z.boolean(),
    memoryMb: z.number().int().min(512).max(131_072),
    cpus: z.number().min(0.5).max(128)
  }),
  search: z.object({
    /** Engine for the WebSearch tool; "auto" picks the first one that is set up. */
    engine: SearchEngineSettingSchema,
    /** A SearXNG instance with its JSON API on. */
    searxngUrl: z.url({ protocol: /^https?$/ }).max(500).nullable()
  }),
  /** Groups of agents (RunAgents): which model each kind of work runs on, and their limits. */
  agents: z.object({
    /** "session": every agent uses the session's model unless its role has one. "auto": quick and research work goes to the cheapest capable model of the same provider. */
    routing: z.enum(['session', 'auto']),
    /** A model per kind of work; null leaves it to routing. */
    roles: z.record(ModelRoleSchema, ModelRefSchema.nullable()),
    /** Most agents working at once. */
    maxParallel: z.number().int().min(1).max(8),
    /** Tokens one agent may spend before it is stopped; null sets no limit. */
    tokenBudget: z.number().int().min(10_000).max(50_000_000).nullable(),
    /** Extra attempts after a provider failure. */
    retries: z.number().int().min(0).max(3)
  }),
  /** Generated images and video: the image model the agent uses, and the user's own ComfyUI. */
  media: z.object({
    /** "auto" uses ComfyUI when it is on, else the first provider that makes images. */
    imageEngine: z.enum(IMAGE_ENGINE_SETTINGS),
    /** A model id for the chosen provider; empty uses that provider's default. */
    imageModel: z.string().max(200),
    comfyEnabled: z.boolean(),
    comfyUrl: z.url({ protocol: /^https?$/ }).max(500),
    /** Checkpoint for plain text-to-image; empty uses the first one installed. */
    comfyCheckpoint: z.string().max(300)
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
  /** Sent to models in the system prompt (never in incognito chats). */
  personalization: z.object({
    about: z.string().max(PERSONALIZATION_MAX),
    instructions: z.string().max(PERSONALIZATION_MAX),
    style: ResponseStyleSchema
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
  appearance: { theme: 'system', palette: 'graft', accent: 'leaf', uiFontSize: 13, codeFontSize: 13, motion: 'system', transcriptWidth: 'narrow' },
  defaults: { model: null, fallbackModel: null, effort: RECOMMENDED_EFFORT, permissionMode: 'ask', useWorktree: false, lastProjectPath: null },
  notifications: { enabled: true, needsInput: true, finished: true, errors: true },
  behavior: { runInTray: false, bypassModeEnabled: false, bypassKeepsChecks: false, autoCompact: true, webSearch: true, computerUse: false, maxSteps: null },
  security: { allowPlaintextKeys: false },
  privacy: { noTraining: true, incognitoLocalOnly: false },
  updates: { enabled: true },
  sandbox: { image: 'node:22-bookworm', network: true, memoryMb: 4096, cpus: 2 },
  search: { engine: 'auto', searxngUrl: null },
  voice: { engine: 'natural', model: 'hexgrad/kokoro-82m', voice: 'af_heart', systemVoice: null, speed: 1 },
  agents: { routing: 'session', roles: Object.fromEntries(MODEL_ROLES.map((role) => [role, null])) as Record<ModelRoleId, null>, maxParallel: 4, tokenBudget: null, retries: 1 },
  media: { imageEngine: 'auto', imageModel: '', comfyEnabled: false, comfyUrl: 'http://127.0.0.1:8188', comfyCheckpoint: '' },
  personalization: { about: '', instructions: '', style: 'default' },
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
  sandbox: AppSettingsSchema.shape.sandbox.partial().optional(),
  search: AppSettingsSchema.shape.search.partial().optional(),
  voice: AppSettingsSchema.shape.voice.partial().optional(),
  media: AppSettingsSchema.shape.media.partial().optional(),
  agents: AppSettingsSchema.shape.agents.partial().optional(),
  personalization: AppSettingsSchema.shape.personalization.partial().optional(),
  shortcuts: z.partialRecord(ShortcutIdSchema, z.string().max(40)).optional(),
  ui: AppSettingsSchema.shape.ui.partial().optional()
});
export type AppSettingsPatch = z.infer<typeof AppSettingsPatchSchema>;
