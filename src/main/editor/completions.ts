import { findSecrets } from '@shared/secrets';

/**
 * What the Files editor's AI sends to a model and what is kept of the answer:
 * suggestions as you type (the text that belongs at the cursor) and Edit with
 * AI (a rewrite of the selected lines). Pure, so it is unit-tested without a
 * provider.
 */

/** How much of the file around the cursor a suggestion is written from. */
export const BEFORE_CHARS = 6_000;
export const AFTER_CHARS = 2_000;
/** Marks the cursor in the text a suggestion is asked for. */
export const CURSOR = '<CURSOR>';
/** What covers a secret, as shared/secrets.ts covers it. A model that copies it would put dots into the file. */
export const COVER = '••••••••';
/** The longest suggestion kept. */
const MAX_LINES = 16;
const MAX_CHARS = 1_200;

/** The end of `text`: at most `max` characters, starting at a line when a line starts in them. */
export function windowBefore(text: string, max = BEFORE_CHARS): string {
  if (text.length <= max) return text;
  const tail = text.slice(text.length - max);
  const newline = tail.indexOf('\n');
  return newline === -1 ? tail : tail.slice(newline + 1);
}

/** The start of `text`: at most `max` characters, ending with a whole line when a line ends in them. */
export function windowAfter(text: string, max = AFTER_CHARS): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const newline = head.lastIndexOf('\n');
  return newline === -1 ? head : head.slice(0, newline);
}

/**
 * Texts that follow one another (before and after the cursor) with their secrets covered as one text would
 * have them: a key that runs across the cursor is covered on both sides, not missed because each half is short.
 */
export function maskParts(parts: string[]): string[] {
  const text = parts.join('');
  const spans = findSecrets(text);
  if (spans.length === 0) return parts;
  let start = 0;
  return parts.map((part) => {
    const end = start + part.length;
    let out = '';
    let at = start;
    for (const span of spans) {
      if (span.end <= start || span.start >= end) continue;
      const from = Math.max(span.start, start);
      const to = Math.min(span.end, end);
      // A vendor's prefix stays readable where the key starts, as everywhere else in Graft.
      const kept = span.start >= start ? text.slice(span.start, Math.min(span.start + span.keep, to)) : '';
      out += text.slice(at, from) + kept + COVER;
      at = to;
    }
    out += text.slice(at, end);
    start = end;
    return out;
  });
}

export const COMPLETION_SYSTEM = [
  `You complete code in an editor. The user sends a file with the cursor marked ${CURSOR}.`,
  'Reply with only the text to insert at the cursor: no explanation, no code fences, and nothing that is already written before or after the cursor.',
  "Match the file's indentation and style. Finish the current line, or the statement or block it starts when that is clearly what comes next.",
  'When nothing useful can be inserted, reply with nothing.'
].join(' ');

/** The message a suggestion is asked for with: the file's name and language, then the code around the cursor. */
export function completionInput(file: string, language: string, before: string, after: string): string {
  return `File: ${file}\nLanguage: ${language}\n\n${before}${CURSOR}${after}`;
}

export const EDIT_SYSTEM = [
  'You change code in an editor as the user asks. The user sends part of a file: the lines to change are between <selection> and </selection>, with the code before and after them.',
  'Reply with only the new text of the selected lines: no explanation, no code fences, nothing from before or after the selection.',
  'Keep the indentation of the selected lines and the style of the file.'
].join(' ');

export interface EditRequest {
  file: string;
  language: string;
  before: string;
  selection: string;
  after: string;
  instruction: string;
  /** The rewrite shown now, when the instruction refines it ("shorter", "use async/await"). */
  proposal?: string | undefined;
}

export function editInput(request: EditRequest): string {
  const refine = request.proposal === undefined ? [] : ['', 'The selected lines were already rewritten as follows. Change this version as the instruction asks:', '<proposal>', request.proposal, '</proposal>'];
  return [
    `File: ${request.file}`,
    `Language: ${request.language}`,
    '',
    '<before>',
    request.before,
    '</before>',
    '<selection>',
    request.selection,
    '</selection>',
    '<after>',
    request.after,
    '</after>',
    ...refine,
    '',
    `Instruction: ${request.instruction}`
  ].join('\n');
}

/** The code of the first fenced block in `text`, or all of `text` when it has none. */
function unfence(text: string): string {
  const closed = /```[^\n`]*\n([\s\S]*?)\n?[ \t]*```/.exec(text);
  if (closed) return closed[1] ?? '';
  const open = /^\s*```[^\n`]*\n/.exec(text);
  return open ? text.slice(open[0].length) : text;
}

const indent = (line: string): number => line.length - line.trimStart().length;
/** Brackets a line leaves open (negative: closes more than it opens). */
const openBrackets = (text: string): number => (text.match(/[([{]/g)?.length ?? 0) - (text.match(/[)\]}]/g)?.length ?? 0);
/** A line that ends like this goes on below: a block, a call or a list, a Python block, an arrow function. */
const OPENS = /(?:[{([:]|=>)\s*$/;

/** How much of the start of `answer` repeats what is before the cursor: lines written again, the current line, or its last words. */
function echoed(answer: string, prefix: string): number {
  const line = prefix.slice(prefix.lastIndexOf('\n') + 1);
  const tails = [line];
  for (let from = prefix.length - line.length, i = 0; i < 12 && from > 0; i++) {
    from = from >= 2 ? prefix.lastIndexOf('\n', from - 2) + 1 : 0;
    tails.push(prefix.slice(from));
  }
  // Longest first: a model that starts a few lines up writes those lines again.
  for (const tail of tails.reverse()) if (tail.trim() && answer.startsWith(tail)) return tail.length;
  const bare = line.trimStart();
  if (bare && answer.startsWith(bare)) return bare.length;
  // The indentation the line already has, written again.
  if (!bare && line && answer.startsWith(line)) return line.length;
  // The line's last word or words, from where a word starts: "items.red" before "items.reduce(…)".
  for (let k = Math.min(bare.length, answer.length); k >= 3; k--) {
    if (line.endsWith(answer.slice(0, k)) && !/[\w$]/.test(line.charAt(line.length - k - 1))) return k;
  }
  return 0;
}

/**
 * Where a suggestion ends naturally. In a line, or finishing a line that opens nothing, it is the rest of that
 * line. Otherwise it runs over lines until a line closes a block it did not open (less indented than its
 * start) or a blank line comes before the next statement at its own level, and never past MAX_LINES.
 */
function naturalEnd(answer: string, prefix: string, suffix: string): string {
  const line = prefix.slice(prefix.lastIndexOf('\n') + 1);
  const rest = suffix.split('\n', 1)[0] ?? '';
  const lines = answer.split('\n');
  const head = lines[0] ?? '';
  const first = line + head;
  if (rest.trim() || (head.trim() && line.trim() && !OPENS.test(first))) return head;
  const base = first.trim() ? indent(first) : indent(lines.find((l, i) => i > 0 && l.trim()) ?? '');
  const kept = [head];
  for (let i = 1; i < lines.length && kept.length < MAX_LINES; i++) {
    const text = lines[i] ?? '';
    if (text.trim()) {
      if (indent(text) < base) break;
    } else {
      const next = lines.slice(i + 1).find((l) => l.trim());
      if (next === undefined || indent(next) <= base) break;
    }
    kept.push(text);
  }
  return kept.join('\n');
}

function capped(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  const cut = text.lastIndexOf('\n', MAX_CHARS);
  return cut > 0 ? text.slice(0, cut) : text.slice(0, MAX_CHARS);
}

/**
 * `answer` without what already follows the cursor: the rest of the line written again (kept when the
 * brackets of the line say it closes something of its own), or whole lines below written again.
 */
function withoutSuffix(answer: string, prefix: string, suffix: string): string {
  const line = prefix.slice(prefix.lastIndexOf('\n') + 1);
  const [rest = '', ...below] = suffix.split('\n');
  const bare = rest.trim();
  if (bare) {
    const body = answer.trimEnd();
    if (!body.endsWith(bare)) return answer;
    const stripped = body.slice(0, -bare.length);
    return Math.abs(openBrackets(line + stripped + rest)) <= Math.abs(openBrackets(line + answer + rest)) ? stripped : answer;
  }
  const lines = answer.split('\n');
  const next = below.filter((l) => l.trim());
  for (let m = Math.min(lines.length - 1, next.length); m >= 1; m--) {
    if (lines.slice(-m).every((l, i) => l.trimEnd() === (next[i] ?? '').trimEnd())) return lines.slice(0, -m).join('\n');
  }
  return answer;
}

/**
 * What of a model's answer goes in at the cursor: without code fences, without what it repeats of the text
 * before or after the cursor, ending where a suggestion ends naturally, with no trailing whitespace. Empty
 * when nothing useful is left, or when it would write a covered secret into the file.
 */
export function cleanCompletion(raw: string, prefix: string, suffix: string): string {
  let text = unfence(raw.replace(/\r\n?/g, '\n')).replaceAll(CURSOR, '');
  text = text.slice(echoed(text, prefix));
  text = withoutSuffix(capped(naturalEnd(text, prefix, suffix)), prefix, suffix);
  text = text
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trimEnd();
  return text.trim() && !text.includes(COVER) ? text : '';
}

const margin = (line: string): string => line.slice(0, indent(line));
/** The indentation of the least indented line that has text. */
function leastMargin(text: string): string {
  let least: string | null = null;
  for (const line of text.split('\n')) if (line.trim() && (least === null || indent(line) < least.length)) least = margin(line);
  return least ?? '';
}

/**
 * The new text for the selected lines from a model's answer: without fences or the tags of the request, and
 * indented at least as far as the selection was (a model that drops the indentation would move the code).
 */
export function cleanReplacement(raw: string, selection: string): string {
  let text = unfence(raw.replace(/\r\n?/g, '\n'))
    .replace(/^\s*<(?:selection|proposal)>\n?/, '')
    .replace(/\n?<\/(?:selection|proposal)>\s*$/, '')
    .trimEnd();
  if (!selection.startsWith('\n')) text = text.replace(/^(?:[ \t]*\n)+/, '');
  const want = leastMargin(selection);
  const have = leastMargin(text);
  if (have.length < want.length) {
    const pad = want.slice(0, want.length - have.length);
    text = text
      .split('\n')
      .map((l) => (l.trim() ? pad + l : l))
      .join('\n');
  }
  return text;
}
