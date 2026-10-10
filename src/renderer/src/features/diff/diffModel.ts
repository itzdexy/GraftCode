/** Unified-diff parsing and side-by-side pairing for the diff renderer (pure; unit-tested). */

export interface DiffRow {
  type: 'hunk' | 'add' | 'del' | 'ctx' | 'note';
  text: string;
  oldNo: number | null;
  newNo: number | null;
  /** Index of the hunk this row belongs to (for per-hunk actions). */
  hunk: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/**
 * Parses a single-file unified patch. File headers (Index/---/+++/diff --git)
 * are recognized only before the first hunk, so removed lines that start
 * with "--" are not mistaken for headers.
 */
export function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let hunk = -1;
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const header = HUNK.exec(line);
    if (header) {
      hunk++;
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      rows.push({ type: 'hunk', text: line, oldNo: null, newNo: null, hunk });
      continue;
    }
    if (hunk === -1) continue;
    if (line.startsWith('+')) rows.push({ type: 'add', text: line.slice(1), oldNo: null, newNo: newNo++, hunk });
    else if (line.startsWith('-')) rows.push({ type: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null, hunk });
    else if (line.startsWith('\\')) rows.push({ type: 'note', text: line.slice(1).trim(), oldNo: null, newNo: null, hunk });
    else rows.push({ type: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line, oldNo: oldNo++, newNo: newNo++, hunk });
  }
  return rows;
}

/** Rows for hunks already split out by the git layer (header + body lines each). */
export function rowsFromHunks(hunks: ReadonlyArray<{ header: string; lines: string[] }>): DiffRow[] {
  return hunks.flatMap((h, index) => parsePatch(`${h.header}\n${h.lines.join('\n')}`).map((row) => ({ ...row, hunk: index })));
}

export interface SplitRow {
  left: DiffRow | null;
  right: DiffRow | null;
  /** Set for hunk header / note rows that span both sides. */
  full: DiffRow | null;
}

/** Pairs removed and added runs line by line; context appears on both sides. */
export function toSplitRows(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: DiffRow[] = [];
  let adds: DiffRow[] = [];
  const flush = (): void => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) out.push({ left: dels[i] ?? null, right: adds[i] ?? null, full: null });
    dels = [];
    adds = [];
  };
  for (const row of rows) {
    if (row.type === 'del') {
      if (adds.length > 0) flush();
      dels.push(row);
    } else if (row.type === 'add') {
      adds.push(row);
    } else {
      flush();
      if (row.type === 'ctx') out.push({ left: row, right: row, full: null });
      else out.push({ left: null, right: null, full: row });
    }
  }
  flush();
  return out;
}

export function countChanges(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.type === 'add') added++;
    else if (r.type === 'del') removed++;
  }
  return { added, removed };
}

// ---- changes inside a line ---------------------------------------------------

/** A run of characters in a line, from `start` up to but not including `end`. */
export interface Span {
  start: number;
  end: number;
}

/** Words, runs of blank space, and every other character on its own. */
const TOKEN = /[A-Za-z0-9_$]+|\s+|[^\sA-Za-z0-9_$]/g;
const IS_WORD = /^[A-Za-z0-9_$]/;
/** Pairs of lines with more tokens than this (multiplied) are left unmarked: the table would be too large. */
const MAX_TABLE = 250_000;
/** Lines that share fewer of their words than this are different lines, not one line that changed. */
const MIN_SHARED = 0.3;

/** Which tokens of each line belong to their longest common subsequence. */
function kept(a: string[], b: string[]): { a: boolean[]; b: boolean[] } {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? (table[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const keepA = a.map(() => false);
  const keepB = b.map(() => false);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      keepA[i++] = true;
      keepB[j++] = true;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) i++;
    else j++;
  }
  return { a: keepA, b: keepB };
}

/** The tokens that were not kept, as spans; marks with only blank space between them join into one. */
function spansOf(tokens: string[], keep: boolean[]): Span[] {
  const spans: Span[] = [];
  let at = 0;
  // Where kept blank space began right after a mark: it may yet turn out to sit between two marks.
  let blankAfterMark: number | null = null;
  tokens.forEach((token, index) => {
    const start = at;
    at += token.length;
    if (keep[index]) {
      blankAfterMark = /^\s+$/.test(token) && spans.at(-1)?.end === start ? start : null;
      return;
    }
    const last = spans.at(-1);
    if (last && (last.end === start || blankAfterMark === last.end)) last.end = at;
    else spans.push({ start, end: at });
    blankAfterMark = null;
  });
  return spans;
}

/**
 * What changed between a removed line and the line that replaced it, as
 * spans in each. Null when nothing can usefully be marked: the lines are
 * the same, one is empty, or they share too little to be one line edited.
 */
export function changedSpans(before: string, after: string): { before: Span[]; after: Span[] } | null {
  if (before === after || before.length === 0 || after.length === 0) return null;
  const a = before.match(TOKEN) ?? [];
  const b = after.match(TOKEN) ?? [];
  if (a.length * b.length > MAX_TABLE) return null;
  const keep = kept(a, b);
  const words = (tokens: string[], mask?: boolean[]): number => tokens.reduce((n, token, i) => (IS_WORD.test(token) && (mask === undefined || mask[i]) ? n + token.length : n), 0);
  const fewest = Math.min(words(a), words(b));
  const shared = fewest === 0 ? a.some((token, i) => keep.a[i] && !/^\s+$/.test(token)) : words(a, keep.a) / fewest >= MIN_SHARED;
  if (!shared) return null;
  return { before: spansOf(a, keep.a), after: spansOf(b, keep.b) };
}

/**
 * The changed words of every line that has a partner: within a change, the
 * first removed line pairs with the first added one, the second with the
 * second, and so on. Keyed by the row's index in `rows`.
 */
export function inlineSpans(rows: DiffRow[]): Map<number, Span[]> {
  const out = new Map<number, Span[]>();
  let dels: number[] = [];
  let adds: number[] = [];
  const flush = (): void => {
    for (let i = 0; i < Math.min(dels.length, adds.length); i++) {
      const del = dels[i];
      const add = adds[i];
      if (del === undefined || add === undefined) continue;
      const spans = changedSpans(rows[del]?.text ?? '', rows[add]?.text ?? '');
      if (!spans) continue;
      if (spans.before.length > 0) out.set(del, spans.before);
      if (spans.after.length > 0) out.set(add, spans.after);
    }
    dels = [];
    adds = [];
  };
  rows.forEach((row, index) => {
    if (row.type === 'del') {
      if (adds.length > 0) flush();
      dels.push(index);
    } else if (row.type === 'add') adds.push(index);
    else flush();
  });
  flush();
  return out;
}

/** A piece of a line: its text, the syntax token it belongs to (-1 without highlighting) and whether it changed. */
export interface Piece {
  text: string;
  token: number;
  changed: boolean;
}

/**
 * Cuts a line where its syntax tokens and its changed spans begin and end,
 * so each piece has one colour and one background. `tokenLengths` are the
 * lengths of the line's tokens in order; they are ignored when they do not
 * add up to the line.
 */
export function pieces(text: string, tokenLengths: number[] | null, spans: Span[]): Piece[] {
  if (text.length === 0) return [];
  const starts: number[] = [];
  let total = 0;
  for (const length of tokenLengths ?? []) {
    starts.push(total);
    total += length;
  }
  const tokens = tokenLengths !== null && total === text.length ? starts : [];
  const cuts = new Set<number>([0, text.length, ...tokens]);
  for (const span of spans) {
    cuts.add(Math.max(0, Math.min(text.length, span.start)));
    cuts.add(Math.max(0, Math.min(text.length, span.end)));
  }
  const sorted = [...cuts].sort((x, y) => x - y);
  const out: Piece[] = [];
  let token = 0;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const start = sorted[i] ?? 0;
    const end = sorted[i + 1] ?? 0;
    while (token + 1 < tokens.length && (tokens[token + 1] ?? 0) <= start) token++;
    out.push({ text: text.slice(start, end), token: tokens.length > 0 ? token : -1, changed: spans.some((span) => start >= span.start && end <= span.end) });
  }
  return out;
}
