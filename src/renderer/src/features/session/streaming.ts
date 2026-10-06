/**
 * A reply while it streams: how it is cut into chunks so settled text needs
 * no more work, how markdown that is still being typed is mended so
 * half-written marks never show, and how fast new text is shown. Pure, so it
 * is unit-tested without a DOM.
 */

/** Settled text is cut into chunks of at least this many characters: few enough chunks, each cheap to parse. */
const CHUNK_MIN = 1200;
/** The part still being written stays at least this long, so words that are still fading in are never cut off into a settled chunk. */
const MIN_TAIL = 160;
/** Link definitions and footnotes can point across a cut, so text with either stays in one piece. */
const POINTS_ELSEWHERE = /^\[[^\]\n]+\]:\s|\[\^/m;
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;

/**
 * Fenced code blocks in a text: whether each line is inside one (the fence
 * lines themselves count as inside), and whether one is still open at the end.
 */
function scanFences(lines: string[]): { inside: boolean[]; open: boolean } {
  let fence: { mark: string; length: number } | null = null;
  const inside = lines.map((line) => {
    const found = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence) {
      if (!found?.[1]) return false;
      fence = { mark: found[1].charAt(0), length: found[1].length };
      return true;
    }
    if (found?.[1] && found[1].startsWith(fence.mark) && found[1].length >= fence.length && (found[2] ?? '').trim() === '') fence = null;
    return true;
  });
  return { inside, open: fence !== null };
}

/** A line that a blank line before it doesn't separate from what came earlier (a list, a quote, a table row, indented text). */
function continues(line: string): boolean {
  return /^[ \t>|]/.test(line) || line.includes('|') || LIST_ITEM.test(line);
}

/**
 * Splits a long reply into chunks that render one after another exactly as
 * the whole would: every cut is between two top-level blocks. The last chunk
 * is the part still being written; the ones before it never change as the
 * reply grows, so only the last has to be parsed again as text arrives.
 * A short reply, or one that can't be cut safely, comes back whole.
 */
export function splitBlocks(text: string): string[] {
  if (text.length < CHUNK_MIN + MIN_TAIL || POINTS_ELSEWHERE.test(text)) return [text];
  const lines = text.split('\n');
  const fenced = scanFences(lines).inside;
  const chunks: string[] = [];
  let start = 0;
  let offset = 0;
  let previous = '';
  let blankBefore = false;
  lines.forEach((line, i) => {
    const inside = fenced[i] === true;
    const opensFence = inside && fenced[i - 1] !== true;
    const betweenBlocks = (!inside || opensFence) && blankBefore && previous !== '' && line.trim() !== '' && !continues(line) && !continues(previous);
    if (betweenBlocks && offset - start >= CHUNK_MIN && text.length - offset >= MIN_TAIL) {
      chunks.push(text.slice(start, offset));
      start = offset;
    }
    if (line.trim() === '') {
      if (!inside) blankBefore = true;
    } else {
      blankBefore = false;
      previous = line;
    }
    offset += line.length + 1;
  });
  chunks.push(text.slice(start));
  return chunks;
}

function count(text: string, mark: string): number {
  return text.split(mark).length - 1;
}

/**
 * Mends the paragraph being written so marks that have opened but not closed
 * yet never show as stray characters: bold and inline code are closed (or
 * dropped while nothing follows them), and a link whose address is still
 * arriving shows as its label. An open code block is left as it is.
 */
export function healMarkdown(text: string): string {
  if (scanFences(text.split('\n')).open) return text;
  const at = text.lastIndexOf('\n\n');
  const start = at === -1 ? 0 : at + 2;
  let last = text.slice(start).replace(/\[([^\]\n]*)\]\([^)\n]*$/, '$1');
  if (count(last, '`') % 2 === 1) last = last.endsWith('`') ? last.slice(0, -1) : `${last}\``;
  if (count(last.replace(/`[^`]*`/g, ''), '**') % 2 === 1) last = last.endsWith('**') ? last.slice(0, -2) : `${last}**`;
  return text.slice(0, start) + last;
}

/** The pace when little is waiting, in characters a second. */
const BASE_RATE = 150;
/** Whatever is waiting is shown within about this long, so a large piece never lags behind. */
const CATCH_UP_SECONDS = 0.3;
/** A word is finished before stopping, up to this many characters. */
const MAX_WORD = 24;

/**
 * How much of `text` to show after `elapsedMs` more, given `shown` characters
 * already showing. Text arrives in uneven bursts; this spreads it over the
 * frames in between, faster the more is waiting, and stops at the end of a
 * word so words appear whole.
 */
export function nextReveal(text: string, shown: number, elapsedMs: number): number {
  const total = text.length;
  if (shown >= total) return total;
  const rate = Math.max(BASE_RATE, (total - shown) / CATCH_UP_SECONDS);
  let next = Math.min(total, shown + Math.max(1, Math.round((rate * elapsedMs) / 1000)));
  const limit = Math.min(total, next + MAX_WORD);
  while (next < limit && !/\s/.test(text.charAt(next))) next++;
  // Never between the two halves of an emoji or another character outside the basic plane.
  const before = text.charCodeAt(next - 1);
  if (next < total && before >= 0xd800 && before <= 0xdbff) next++;
  return next;
}
