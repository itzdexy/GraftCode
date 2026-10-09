import { z } from 'zod';

/** Side panels: terminals, file browsing, background commands, and the browser. */

export const TerminalInfoSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  title: z.string(),
  cwd: z.string(),
  exitCode: z.number().int().nullable(),
  exited: z.boolean()
});
export type TerminalInfoView = z.infer<typeof TerminalInfoSchema>;

export const TreeEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['file', 'dir']),
  size: z.number().int().nullable()
});
export type TreeEntryView = z.infer<typeof TreeEntrySchema>;

export const FilePreviewSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  path: z.string(),
  content: z.string().nullable(),
  binary: z.boolean(),
  tooLarge: z.boolean(),
  size: z.number().int(),
  /** A picture, clip or sound, shown through a preview address (files:previewUrl) instead of as text. */
  media: z.enum(['image', 'video', 'audio']).nullable()
});
export type FilePreviewView = z.infer<typeof FilePreviewSchema>;

export const BackgroundShellSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  command: z.string(),
  status: z.enum(['running', 'exited', 'killed', 'failed']),
  exitCode: z.number().int().nullable(),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  logPath: z.string()
});
export type BackgroundShellView = z.infer<typeof BackgroundShellSchema>;

export const BrowserStateSchema = z.object({
  url: z.string(),
  title: z.string(),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  error: z.string().nullable(),
  zoom: z.number(),
  /** Errors and warnings the page logged since it loaded. */
  problems: z.number().int(),
  find: z.object({ active: z.number().int(), matches: z.number().int() }).nullable(),
  devtools: z.boolean(),
  picking: z.boolean()
});
export type BrowserStateView = z.infer<typeof BrowserStateSchema>;

export const ConsoleEntrySchema = z.object({
  level: z.enum(['debug', 'info', 'warning', 'error']),
  message: z.string(),
  source: z.string(),
  line: z.number().int(),
  at: z.number()
});
export type ConsoleEntryView = z.infer<typeof ConsoleEntrySchema>;

export const PickedElementSchema = z.object({
  url: z.string(),
  selector: z.string(),
  html: z.string(),
  text: z.string(),
  size: z.object({ width: z.number(), height: z.number() }),
  styles: z.record(z.string(), z.string())
});
export type PickedElementView = z.infer<typeof PickedElementSchema>;

export const BROWSER_COMMANDS = [
  'back',
  'forward',
  'reload',
  'hardReload',
  'stop',
  'close',
  'external',
  'devtools',
  'zoomIn',
  'zoomOut',
  'zoomReset',
  'stopFind',
  'clearConsole',
  'clearData',
  'cancelPick'
] as const;
export type BrowserCommand = (typeof BROWSER_COMMANDS)[number];

export const BoundsSchema = z.object({
  x: z.number().min(0).max(100_000),
  y: z.number().min(0).max(100_000),
  width: z.number().min(0).max(100_000),
  height: z.number().min(0).max(100_000)
});
