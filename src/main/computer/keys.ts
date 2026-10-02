/**
 * Pure helpers for computer use: key names to Windows virtual-key codes, and
 * screenshot coordinates (what the model sees) to physical screen pixels.
 */

const NAMED: Record<string, number> = {
  ctrl: 0x11,
  control: 0x11,
  shift: 0x10,
  alt: 0x12,
  option: 0x12,
  win: 0x5b,
  super: 0x5b,
  meta: 0x5b,
  cmd: 0x5b,
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  esc: 0x1b,
  escape: 0x1b,
  space: 0x20,
  backspace: 0x08,
  delete: 0x2e,
  del: 0x2e,
  insert: 0x2d,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  capslock: 0x14,
  printscreen: 0x2c,
  menu: 0x5d,
  minus: 0xbd,
  '-': 0xbd,
  plus: 0xbb,
  '=': 0xbb,
  comma: 0xbc,
  ',': 0xbc,
  period: 0xbe,
  '.': 0xbe,
  slash: 0xbf,
  '/': 0xbf,
  semicolon: 0xba,
  ';': 0xba,
  quote: 0xde,
  "'": 0xde,
  backquote: 0xc0,
  '`': 0xc0,
  '[': 0xdb,
  ']': 0xdd,
  '\\': 0xdc
};

/** "ctrl+shift+s" → [0x11, 0x10, 0x53]; null when a key name isn't known. */
export function virtualKeys(combo: string): number[] | null {
  const names = combo
    .toLowerCase()
    .split(/\s*\+\s*/)
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  if (names.length === 0 || names.length > 4) return null;
  const codes: number[] = [];
  for (const name of names) {
    const named = NAMED[name];
    if (named !== undefined) codes.push(named);
    else if (/^[a-z]$/.test(name)) codes.push(name.toUpperCase().charCodeAt(0));
    else if (/^[0-9]$/.test(name)) codes.push(name.charCodeAt(0));
    else if (/^f([1-9]|1[0-2])$/.test(name)) codes.push(0x6f + Number(name.slice(1)));
    else return null;
  }
  return codes;
}

export interface ShotGeometry {
  /** Size of the screenshot the model saw. */
  width: number;
  height: number;
  /** The captured display in physical pixels. */
  display: { x: number; y: number; width: number; height: number };
}

/** A point in screenshot space as a physical screen pixel, clamped to the display. */
export function toScreen(x: number, y: number, shot: ShotGeometry): { x: number; y: number } {
  const px = Math.round((x * shot.display.width) / shot.width);
  const py = Math.round((y * shot.display.height) / shot.height);
  return {
    x: shot.display.x + Math.min(shot.display.width - 1, Math.max(0, px)),
    y: shot.display.y + Math.min(shot.display.height - 1, Math.max(0, py))
  };
}

/** Largest size within the limits that keeps the display's proportions (never upscaled). */
export function fitWithin(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
