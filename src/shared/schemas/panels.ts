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

/** What is wrong in a page, as the page check found it (main: browser/pageCheck.ts). */
export const PAGE_RULES = ['overflow', 'contrast', 'name', 'image', 'heading', 'target', 'document'] as const;
export const PageFindingSchema = z.object({
  rule: z.enum(PAGE_RULES),
  severity: z.enum(['error', 'warning']),
  /** One sentence, with the numbers. */
  message: z.string(),
  /** A selector that finds it in the page; empty for the page as a whole. */
  selector: z.string(),
  /** What it shows or is called, so a person knows it again. */
  label: z.string()
});
export type PageFinding = z.infer<typeof PageFindingSchema>;

export const PageCheckSchema = z.object({
  url: z.string(),
  title: z.string(),
  /** The width the page was laid out at when it was looked at. */
  width: z.number(),
  findings: z.array(PageFindingSchema),
  /** Findings beyond the ones listed. */
  more: z.number().int().nonnegative(),
  /** What was looked at, so "nothing found" has a size. */
  looked: z.object({ texts: z.number().int(), images: z.number().int(), controls: z.number().int(), headings: z.number().int() }),
  /** Texts whose contrast could not be judged (a picture or a gradient is behind them). */
  unjudged: z.number().int().nonnegative(),
  /** A list was cut at its limit: the page has more than was looked at. */
  partial: z.boolean()
});
export type PageCheck = z.infer<typeof PageCheckSchema>;

/** The sizes a page is looked at beside the panel's own: a phone, a tablet and a desktop. */
export const PAGE_SIZES = [
  { id: 'phone', label: 'Phone', width: 390, height: 844 },
  { id: 'tablet', label: 'Tablet', width: 768, height: 1024 },
  { id: 'desktop', label: 'Desktop', width: 1280, height: 800 }
] as const;
/** The size a page is laid out at for a picture or a check; the panel's own size is something else. */
export interface PageSize {
  width: number;
  height: number;
}
/** The size to look at a page that is asked for at a width: as tall as the device that is about as wide. */
export function sizeForWidth(width: number): PageSize {
  return { width, height: width <= 480 ? 844 : width <= 1024 ? 1024 : width <= 1440 ? 800 : 1080 };
}
/** The widths a page can be asked to lay itself out at. */
export const PageWidthSchema = z.number().int().min(320).max(1920);

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
