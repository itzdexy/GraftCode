import writeExcelFile, { type Cell as WrittenCell, type SheetData } from 'write-excel-file/node';

/**
 * Rows as a spreadsheet (.xlsx). The rows come as CSV or a JSON list of rows
 * (one sheet), or as a JSON object of sheet name to rows (several). Numbers
 * and formulas become real cells; text that only looks like a number ("007")
 * stays text.
 */

export const MAX_SHEETS = 20;
export const MAX_ROWS = 100_000;
/** The most columns a sheet has, and the most characters a cell holds, in the apps that open these files. */
export const MAX_COLUMNS = 16_384;
export const MAX_CELL_CHARS = 32_767;

export type Cell = string | number | boolean | null;

export interface Sheet {
  name: string;
  rows: Cell[][];
}

/**
 * Reads CSV as spreadsheets write it (RFC 4180): quoted cells may hold the
 * separator, line breaks and doubled quotes. A byte-order mark is dropped,
 * and the separator is ";" or a tab when the first line has more of those
 * than commas, as exports from some locales do.
 *
 * Two things are read more kindly than the rule says, because models write
 * them. A space after each comma: a cell loses the spaces around it unless it
 * is quoted, and a quote may open after them. And a formula whose commas were
 * not put in quotes, =IF(A1>0,"yes","no"): a cell that starts with "=" holds
 * together until its brackets and its own quotes close, or its line ends.
 */
export function parseCsv(text: string): string[][] {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const first = source.split(/\r?\n/, 1)[0] ?? '';
  const count = (mark: string): number => first.split(mark).length - 1;
  const separator = count(';') > count(',') && count(';') >= count('\t') ? ';' : count('\t') > count(',') ? '\t' : ',';

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  /** Inside a quoted cell. */
  let quoted = false;
  /** The cell being read was quoted: its text is kept as written. */
  let wasQuoted = false;
  let line = 1;
  let quoteLine = 1;
  /** The row being read has something in it (a final line break starts no row). */
  let started = false;
  /** The cell being read holds nothing but spaces so far. */
  let blank = true;
  /** The cell being read is a formula written without quotes, with this many brackets open, inside or outside its own text. */
  let formula = false;
  let open = 0;
  let inText = false;
  const endCell = (): void => {
    row.push(wasQuoted ? cell : cell.trim());
    cell = '';
    wasQuoted = false;
    blank = true;
    formula = false;
    open = 0;
    inText = false;
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (quoted) {
      if (ch !== '"') {
        if (ch === '\n') line++;
        cell += ch;
      } else if (source[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = false;
      }
    } else if (ch === '"' && !wasQuoted && blank) {
      quoted = true;
      wasQuoted = true;
      cell = '';
      quoteLine = line;
      started = true;
    } else if (ch === separator && !(formula && (open > 0 || inText))) {
      endCell();
      started = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      endCell();
      rows.push(row);
      row = [];
      started = false;
      line++;
    } else if (!wasQuoted || ch.trim() !== '') {
      // Spaces after a closing quote are not part of the cell.
      if (blank && ch.trim() !== '') {
        blank = false;
        formula = !wasQuoted && ch === '=';
      }
      if (formula) {
        if (ch === '"') inText = !inText;
        else if (!inText && ch === '(') open++;
        else if (!inText && ch === ')') open = Math.max(0, open - 1);
      }
      cell += ch;
      started = true;
    }
  }
  if (quoted) throw new Error(`Line ${String(quoteLine)} has a quote that is never closed.`);
  if (started) {
    endCell();
    rows.push(row);
  }
  return rows;
}

/** Digits with an optional sign and decimal part, and no leading zero: "3", "-0.5", never "007". */
const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;
/** The digits a spreadsheet number holds exactly. A longer one (an account number, a barcode) would be rounded, so it stays text. */
const MAX_DIGITS = 15;

/** Whether a number written out in digits is one a sheet stores without rounding it. */
function exact(digits: string): boolean {
  return digits.replace(/[-.]/g, '').length <= MAX_DIGITS;
}

function typed(cell: string): Cell {
  return NUMBER.test(cell) && exact(cell) ? Number(cell) : cell;
}

/**
 * Functions that reach outside the workbook when it is opened or recalculated:
 * they fetch an address, start a program's data exchange or call into a
 * library. A formula using one is kept as text.
 */
const REACHES_OUT = /(?<!\w)(WEBSERVICE|FILTERXML|RTD|CALL|REGISTER|REGISTER\.ID|EXEC|DDE|IMPORTXML|IMPORTDATA|IMPORTHTML|IMPORTFEED|IMPORTRANGE|IMAGE)\s*\(/i;
/** A link to anything but a web or mail address written out in the formula (a file, a share, an address taken from a cell). */
const UNSAFE_LINK = /(?<!\w)HYPERLINK\s*\(\s*(?!"(?:https?:\/\/|mailto:))/i;

/**
 * Functions newer than the file format. A file stores them with a prefix, and
 * without it the app shows #NAME? until the cell is typed again. Functions that
 * take a LAMBDA or name their own variables need more than a prefix and are
 * left as written.
 */
const NEWER =
  'ACOT ACOTH AGGREGATE ARABIC ARRAYTOTEXT BASE BETA.DIST BETA.INV BINOM.DIST BINOM.DIST.RANGE BINOM.INV BITAND BITLSHIFT BITOR BITRSHIFT BITXOR CEILING.MATH CEILING.PRECISE CHISQ.DIST CHISQ.DIST.RT CHISQ.INV CHISQ.INV.RT CHISQ.TEST CHOOSECOLS CHOOSEROWS COMBINA CONCAT CONFIDENCE.NORM CONFIDENCE.T COT COTH COVARIANCE.P COVARIANCE.S CSC CSCH DAYS DECIMAL DROP ERF.PRECISE ERFC.PRECISE EXPAND EXPON.DIST F.DIST F.DIST.RT F.INV F.INV.RT F.TEST FLOOR.MATH FLOOR.PRECISE FORECAST.LINEAR FORMULATEXT GAMMA GAMMA.DIST GAMMA.INV GAMMALN.PRECISE GAUSS HSTACK HYPGEOM.DIST IFNA IFS IMCOSH IMCOT IMCSC IMCSCH IMSEC IMSECH IMSINH IMTAN ISFORMULA ISOWEEKNUM LOGNORM.DIST LOGNORM.INV MAXIFS MINIFS MODE.MULT MODE.SNGL MUNIT NEGBINOM.DIST NORM.DIST NORM.INV NORM.S.DIST NORM.S.INV NUMBERVALUE PDURATION PERCENTILE.EXC PERCENTILE.INC PERCENTRANK.EXC PERCENTRANK.INC PERMUTATIONA PHI POISSON.DIST QUARTILE.EXC QUARTILE.INC RANDARRAY RANK.AVG RANK.EQ RRI SEC SECH SEQUENCE SHEET SHEETS SKEW.P SORTBY STDEV.P STDEV.S SWITCH T.DIST T.DIST.2T T.DIST.RT T.INV T.INV.2T T.TEST TAKE TEXTAFTER TEXTBEFORE TEXTJOIN TEXTSPLIT TOCOL TOROW UNICHAR UNICODE UNIQUE VALUETOTEXT VAR.P VAR.S VSTACK WEIBULL.DIST WRAPCOLS WRAPROWS XLOOKUP XMATCH XOR Z.TEST'.split(
    ' '
  );
const NEWER_PREFIX = new Map<string, string>([...NEWER.map((name): [string, string] => [name, '_xlfn.']), ['FILTER', '_xlfn._xlws.'], ['SORT', '_xlfn._xlws.']]);
const NEWER_CALL = new RegExp(`(?<![\\w.])(${[...NEWER_PREFIX.keys()].map((name) => name.replace(/\./g, '\\.')).join('|')})(?=\\s*\\()`, 'gi');

/**
 * The expression of a cell written as a formula, as the file stores it:
 * "=SUM(A1;A3)" gives "SUM(A1,A3)". The format has no equals sign, commas
 * between arguments, and a prefix on newer functions.
 *
 * Null when the cell stays text instead:
 * - it only starts like a formula ("=== Totals ===", "=> see below", a bracket
 *   or quote left open, semicolons next to decimal commas): a formula that
 *   cannot be read makes a spreadsheet app report the whole file as damaged;
 * - it reaches outside the workbook (another file, a share, a program, an
 *   address): what a model wrote must not run or call out when a file opens.
 */
function formulaOf(cell: string): string | null {
  if (!cell.startsWith('=')) return null;
  const body = cell.slice(1).trim();
  if (body === '' || /^[=<>*/^&,;)]/.test(body) || /[=<>+\-*/^&,;(]$/.test(body)) return null;
  // Text in double quotes is only text; everything else is the formula proper.
  const parts = body.split(/("(?:[^"]|"")*")/);
  const code = parts.filter((_, i) => i % 2 === 0);
  const bare = code.join(' ');
  if (bare.includes('"')) return null;
  if (/[|[\]\\]/.test(bare) || REACHES_OUT.test(bare) || UNSAFE_LINK.test(body)) return null;
  let depth = 0;
  let braces = 0;
  let semicolons = false;
  let commas = false;
  for (const ch of bare) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return null;
    else if (ch === '{') braces++;
    else if (ch === '}') braces--;
    else if (braces === 0 && ch === ';') semicolons = true;
    else if (braces === 0 && ch === ',') commas = true;
  }
  if (depth !== 0 || (semicolons && commas)) return null;
  // Inside braces a semicolon ends a row of a list of values; anywhere else it stands for the comma between arguments.
  const stored = (text: string): string => {
    let inBraces = 0;
    let out = '';
    for (const ch of text) {
      if (ch === '{') inBraces++;
      else if (ch === '}') inBraces--;
      out += ch === ';' && inBraces === 0 ? ',' : ch;
    }
    return out.replace(NEWER_CALL, (name) => `${NEWER_PREFIX.get(name.toUpperCase()) ?? ''}${name.toUpperCase()}`);
  };
  return parts.map((part, i) => (i % 2 === 0 ? stored(part) : part)).join('');
}

/**
 * A name a sheet may have: none of \ / ? * [ ] :, no apostrophe at either
 * end, not "History" (apps keep that one for themselves), at most 31
 * characters, and no two alike.
 */
function sheetName(raw: string, taken: Set<string>): string {
  const cleaned = raw
    .replace(/[\\/?*[\]:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^'+|'+$/g, '')
    .slice(0, 31);
  const base = (/^history$/i.test(cleaned) ? `${cleaned}_` : cleaned) || `Sheet${String(taken.size + 1)}`;
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - ` (${String(n)})`.length)} (${String(n)})`;
  taken.add(name.toLowerCase());
  return name;
}

/** Refuses what a sheet cannot hold: a file with it in would not open. */
function checked(sheet: Sheet): Sheet {
  const count = (n: number): string => n.toLocaleString('en-US');
  if (sheet.rows.length > MAX_ROWS) throw new Error(`Sheet "${sheet.name}" has more than ${count(MAX_ROWS)} rows.`);
  sheet.rows.forEach((row, r) => {
    if (row.length > MAX_COLUMNS) throw new Error(`Sheet "${sheet.name}" has more than ${count(MAX_COLUMNS)} columns.`);
    if (row.some((cell) => typeof cell === 'string' && cell.length > MAX_CELL_CHARS)) {
      throw new Error(`Sheet "${sheet.name}" has a cell of more than ${count(MAX_CELL_CHARS)} characters (row ${String(r + 1)}).`);
    }
  });
  return sheet;
}

/**
 * JSON with its long numbers kept as written: a number of more than 15 digits
 * (an account number, an id) would be rounded on the way in, so it comes back
 * as the text it was. JSON.parse hands a reviver the source text of each value.
 */
function parseJson(source: string): unknown {
  type Reviver = (key: string, value: unknown, context?: { source?: string }) => unknown;
  return (JSON.parse as (text: string, reviver: Reviver) => unknown)(source, (_key, value, context) => {
    const written = typeof value === 'number' ? context?.source : undefined;
    return written !== undefined && /^-?\d+(\.\d+)?$/.test(written) && !exact(written) ? written : value;
  });
}

/** A cell as JSON gave it. A number no sheet can store (1e400 reads as infinity) and anything nested become text. */
function jsonCell(cell: unknown): Cell {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : String(cell);
  if (cell === null || typeof cell === 'string' || typeof cell === 'boolean') return cell;
  return JSON.stringify(cell);
}

function isRows(value: unknown): value is unknown[][] {
  return Array.isArray(value) && value.every((row) => Array.isArray(row));
}

const SHAPES = 'Give the rows as CSV, as a JSON list of rows, or as a JSON object of sheet name to rows.';

export function parseSheets(source: string): Sheet[] {
  const first = source.trimStart()[0];
  let parsed: unknown;
  if (first === '{' || first === '[') {
    try {
      parsed = parseJson(source);
    } catch (error) {
      // CSV may well start with a bracket ("[draft] title,qty"); an object that does not parse was meant as JSON.
      if (first === '{') throw new Error(`The rows are not valid JSON (${(error as Error).message}). ${SHAPES}`, { cause: error });
    }
  }
  if (parsed === undefined) return [checked({ name: 'Sheet1', rows: parseCsv(source).map((row) => row.map(typed)) })];
  if (Array.isArray(parsed)) {
    if (!isRows(parsed)) throw new Error(SHAPES);
    return [checked({ name: 'Sheet1', rows: parsed.map((row) => row.map(jsonCell)) })];
  }
  if (parsed === null || typeof parsed !== 'object') throw new Error(SHAPES);
  const entries = Object.entries(parsed);
  if (entries.length > MAX_SHEETS) throw new Error(`A spreadsheet can have up to ${String(MAX_SHEETS)} sheets.`);
  const taken = new Set<string>();
  return entries.map(([raw, value]) => {
    const name = sheetName(raw, taken);
    if (!isRows(value)) throw new Error(`Sheet "${name}" must be a list of rows, each a list of cells.`);
    return checked({ name, rows: value.map((row) => row.map(jsonCell)) });
  });
}

export function sheetsToXlsx(sheets: Sheet[]): Promise<Buffer> {
  const written = sheets.map((sheet) => {
    const widths: number[] = [];
    const data: SheetData = sheet.rows.map((row, r) =>
      row.map((cell, c): WrittenCell => {
        const shown = cell === null ? '' : String(cell);
        widths[c] = Math.max(widths[c] ?? 0, ...shown.split('\n').map((part) => part.length));
        if (cell === null || cell === '') return null;
        const bold = r === 0 ? { fontWeight: 'bold' as const } : {};
        if (typeof cell === 'number') return { value: cell, type: Number, ...bold };
        if (typeof cell === 'boolean') return { value: cell, type: Boolean, ...bold };
        const formula = formulaOf(cell);
        if (formula !== null) return { value: formula, type: 'Formula', ...bold };
        return { value: cell, type: String, ...bold };
      })
    );
    // A column is as wide as its longest cell, within reason.
    return { data, sheet: sheet.name, columns: Array.from(widths, (width) => ({ width: Math.min(60, Math.max(8, (width ?? 0) + 2)) })) };
  });
  return writeExcelFile(written).toBuffer();
}
