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
  path: z.string(),
  content: z.string().nullable(),
  binary: z.boolean(),
  tooLarge: z.boolean(),
  size: z.number().int()
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
  error: z.string().nullable()
});
export type BrowserStateView = z.infer<typeof BrowserStateSchema>;

export const BoundsSchema = z.object({
  x: z.number().min(0).max(100_000),
  y: z.number().min(0).max(100_000),
  width: z.number().min(0).max(100_000),
  height: z.number().min(0).max(100_000)
});
