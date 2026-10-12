/** A file named in a reply, and the place in it when one is given (pure; unit-tested). */

export interface FileRef {
  /** As written, with "/" between its parts and without a leading "./". */
  path: string;
  line: number | null;
  endLine: number | null;
  column: number | null;
}

/** Longer than any path plus its place: such a span is code, and is not looked at. */
const MAX_TEXT = 300;
const MAX_PATH = 260;
/**
 * `<path>`, then nothing, `:<line>`, `:<line>-<line>`, `:<line>:<column>` or `#L<line>`.
 * A drive's colon is followed by a slash and never by a digit, so it stays with the path.
 */
const PLACE = /^(.+?)(?::([1-9]\d{0,7})(?:-([1-9]\d{0,7})|:([1-9]\d{0,7}))?|#L([1-9]\d{0,7}))?$/;
const HAS_EXTENSION = /\.[A-Za-z0-9]{1,10}$/;
const WHOLE_NAMES: ReadonlySet<string> = new Set(['Dockerfile', 'Makefile']);

const numberOf = (digits: string | undefined): number | null => (digits === undefined ? null : Number(digits));

/**
 * Reads the whole text of an inline code span as a file reference, or null
 * when it is something else: a call (`health()`), a version (`0.6.18`), an
 * address, a word. Whether such a file exists is asked afterwards.
 */
export function parseFileRef(text: string): FileRef | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TEXT || /\s/.test(trimmed) || trimmed.includes('://') || trimmed.endsWith('()')) return null;
  const match = PLACE.exec(trimmed);
  if (!match) return null;
  const path = (match[1] ?? '').replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  if (path.length === 0 || path.length > MAX_PATH || /^[\d.]+$/.test(path)) return null;
  const last = path.slice(path.lastIndexOf('/') + 1);
  if (!HAS_EXTENSION.test(last) && !WHOLE_NAMES.has(last)) return null;
  const line = numberOf(match[2] ?? match[5]);
  const end = numberOf(match[3]);
  return { path, line, endLine: line !== null && end !== null && end >= line ? end : null, column: numberOf(match[4]) };
}

export function refTooltip(path: string, line: number | null): string {
  return line === null ? `Open ${path}` : `Open ${path} at line ${String(line)}`;
}
