/** What a fenced code block is and what can be done with it (pure; unit-tested). */

import { parseFileRef, type FileRef } from './fileRefs';

/** A finished block of more lines than this is folded… */
export const FOLD_OVER = 40;
/** …to its first lines, this many. */
export const FOLD_SHOWN = 20;
/** From this many lines on, the header says how many there are. */
export const COUNT_FROM = 12;

const MAX_TERMINAL_LINE = 2000;
const MAX_DRAWN_LINE = 60;
const SHELLS: ReadonlySet<string> = new Set(['bash', 'sh', 'shell', 'zsh', 'powershell', 'pwsh', 'ps1', 'cmd', 'bat']);
/** `title="src/app.ts"`, `filename='src/app.ts'`, `filename=src/app.ts`. */
const NAMED = /(?:^|\s)(?:title|filename)=(?:"([^"]*)"|'([^']*)'|(\S+))/;
/** Anything a terminal would take for a key press instead of text: Enter, Tab, Escape and the rest of both control ranges. */
// eslint-disable-next-line no-control-regex -- the control characters are the point
const KEY_PRESS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The language and the file a fence names. The first word is the language,
 * unless it is itself a file (`src/app.ts`: a file has an extension, so `ts`
 * alone never is one). Otherwise the file is what `title=` or `filename=`
 * gives, else the first word of the rest when that is a file.
 */
export function fenceInfo(language: string | null, meta: string | null): { language: string | null; ref: FileRef | null } {
  const first = language === null ? null : parseFileRef(language);
  if (first) return { language: null, ref: first };
  const rest = meta?.trim() ?? '';
  const named = NAMED.exec(rest);
  const written = named ? (named[1] ?? named[2] ?? named[3] ?? '') : (rest.split(/\s+/)[0] ?? '');
  return { language, ref: parseFileRef(written) };
}

export function lineCount(code: string): number {
  return code.length === 0 ? 0 : code.split('\n').length;
}

/** How many of a block's lines to draw. A block that is still being written is never folded: its end is what is being read. */
export function foldedCode(code: string, live: boolean, expanded: boolean): { shown: number; total: number; folded: boolean } {
  const total = lineCount(code);
  const folded = !live && !expanded && total > FOLD_OVER;
  return { shown: folded ? FOLD_SHOWN : total, total, folded };
}

/**
 * The line a shell block would have typed into the terminal, without its
 * prompt, or null when the block is not one plain command line. Several lines
 * would start running at the first line break, and a control character is a
 * key press, so neither is ever typed: the user presses Enter, nothing else.
 */
export function terminalLine(code: string, language: string | null): string | null {
  if (language === null || !SHELLS.has(language.toLowerCase())) return null;
  const line = code.trim().replace(/^[$>](?: +|$)/, '');
  if (line.length === 0 || line.length > MAX_TERMINAL_LINE || KEY_PRESS.test(line)) return null;
  return line;
}

/** The message that asks for a Mermaid block to be redrawn as a diagram: it names the block by its first line. */
export function drawRequest(code: string): string {
  const first = code.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
  return `/diagram Redraw the Mermaid diagram from your last reply that begins "${first.slice(0, MAX_DRAWN_LINE).replace(/"/g, "'")}"`;
}
