import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { log } from './log';

const WindowStateSchema = z.object({
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  width: z.number().int().min(300),
  height: z.number().int().min(200),
  maximized: z.boolean()
});
export type WindowState = z.infer<typeof WindowStateSchema>;

export interface DisplayArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_WINDOW: WindowState = { width: 1280, height: 860, maximized: false };
export const MIN_WINDOW = { width: 900, height: 600 };

/** Reads the persisted window state; invalid or missing files fall back to defaults. */
export function loadWindowState(file: string): WindowState {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('window', 'Could not read window state', { message: (error as Error).message });
    }
    return DEFAULT_WINDOW;
  }
  try {
    const parsed = WindowStateSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    log.warn('window', 'Ignoring malformed window state');
  } catch (error) {
    log.warn('window', 'Ignoring unreadable window state', { message: (error as Error).message });
  }
  return DEFAULT_WINDOW;
}

export function saveWindowState(file: string, state: WindowState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}

/**
 * Keeps a restored window reachable: clamps size to the minimum and drops the
 * position when the window would not overlap any display by at least 64px.
 */
export function fitToDisplays(state: WindowState, displays: DisplayArea[]): WindowState {
  const width = Math.max(state.width, MIN_WINDOW.width);
  const height = Math.max(state.height, MIN_WINDOW.height);
  if (state.x === undefined || state.y === undefined) return { width, height, maximized: state.maximized };
  const { x, y } = state;
  const visible = displays.some((d) => {
    const overlapX = Math.min(x + width, d.x + d.width) - Math.max(x, d.x);
    const overlapY = Math.min(y + height, d.y + d.height) - Math.max(y, d.y);
    return overlapX >= 64 && overlapY >= 64;
  });
  return visible ? { x, y, width, height, maximized: state.maximized } : { width, height, maximized: state.maximized };
}
