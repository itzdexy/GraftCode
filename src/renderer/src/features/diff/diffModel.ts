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
