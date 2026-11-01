/**
 * The marks Graft's shell integration prints around each command in the Terminal panel (OSC 133, as FinalTerm named
 * them): A where the prompt starts, B where the typed command starts, C where its output starts and D;<code> when it
 * is done. "133;P;Cwd=<folder>" and OSC 7 (file://host/folder) say which folder the shell is in. Pure: the terminal
 * view reads them through xterm's parser and the pty manager through MarkScanner.
 */
export type Mark =
  | { kind: 'prompt' }
  | { kind: 'command' }
  | { kind: 'output' }
  /** `exitCode` is null when the shell gave none. */
  | { kind: 'done'; exitCode: number | null }
  | { kind: 'cwd'; path: string };

/** What an OSC sequence with this number and text says, or null when it is not a mark. */
export function parseMark(ident: number, payload: string): Mark | null {
  if (ident === 7) return cwdFromUrl(payload);
  if (ident !== 133) return null;
  const [kind, code] = payload.split(';');
  switch (kind) {
    case 'A':
      return { kind: 'prompt' };
    case 'B':
      return { kind: 'command' };
    case 'C':
      return { kind: 'output' };
    case 'D':
      return { kind: 'done', exitCode: code !== undefined && /^-?\d{1,10}$/.test(code) ? Number(code) : null };
    case 'P': {
      // A folder may hold semicolons: everything after "Cwd=" is the folder.
      const value = payload.slice(2);
      return value.startsWith('Cwd=') && value.length > 4 ? { kind: 'cwd', path: value.slice(4) } : null;
    }
    default:
      return null;
  }
}

/** OSC 7: file://host/path, the path percent-encoded; "/C:/x" is the Windows folder C:/x. */
function cwdFromUrl(payload: string): Mark | null {
  const match = /^file:\/\/[^/]*(\/.*)$/.exec(payload);
  if (!match?.[1]) return null;
  try {
    const path = decodeURIComponent(match[1]);
    return { kind: 'cwd', path: /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path };
  } catch {
    return null;
  }
}

/** A mark whose end has not come after this many characters is not one, and is let go. */
const MAX_MARK = 8_192;

/** Finds the marks in a stream of output, also one that arrives split between two chunks. */
export class MarkScanner {
  private carry = '';

  scan(chunk: string): Mark[] {
    const text = this.carry + chunk;
    this.carry = '';
    const marks: Mark[] = [];
    let at = 0;
    for (;;) {
      const start = text.indexOf('\x1b]', at);
      if (start === -1) {
        // The chunk may end between the ESC and the "]".
        if (text.endsWith('\x1b')) this.carry = '\x1b';
        return marks;
      }
      const bel = text.indexOf('\x07', start + 2);
      const st = text.indexOf('\x1b\\', start + 2);
      const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
      if (end === -1) {
        if (text.length - start <= MAX_MARK) this.carry = text.slice(start);
        return marks;
      }
      const body = text.slice(start + 2, end);
      const semi = body.indexOf(';');
      const mark = semi > 0 && /^\d+$/.test(body.slice(0, semi)) ? parseMark(Number(body.slice(0, semi)), body.slice(semi + 1)) : null;
      if (mark) marks.push(mark);
      at = end + (end === bel ? 1 : 2);
    }
  }
}
