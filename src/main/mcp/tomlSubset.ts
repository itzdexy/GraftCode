/**
 * Just enough TOML to read the [mcp_servers.<name>] tables of another tool's
 * config.toml, without a dependency: tables, arrays of tables and dotted
 * keys; strings (basic and literal, on one line or in triple quotes),
 * arrays, inline tables, booleans and numbers. A date is kept as its text. A
 * syntax error throws with its line number. Tables have no prototype, so a
 * key such as "__proto__" is only a key.
 */

export type TomlTable = { [key: string]: unknown };

const BARE_KEY = /[A-Za-z0-9_-]/;
const ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

function table(): TomlTable {
  return Object.create(null) as TomlTable;
}

function isTable(value: unknown): value is TomlTable {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class Reader {
  private at = 0;

  constructor(private readonly text: string) {}

  get done(): boolean {
    return this.at >= this.text.length;
  }

  fail(what: string): never {
    throw new Error(`line ${String(this.text.slice(0, this.at).split('\n').length)}: ${what}`);
  }

  peek(ahead = 0): string {
    return this.text[this.at + ahead] ?? '';
  }

  take(expected: string): void {
    if (!this.text.startsWith(expected, this.at)) this.fail(`expected ${expected}`);
    this.at += expected.length;
  }

  /** Spaces and tabs. */
  blank(): void {
    while (this.peek() === ' ' || this.peek() === '\t') this.at++;
  }

  /** Blank lines and comments too, as between the items of an array. */
  space(): void {
    for (;;) {
      this.blank();
      if (this.peek() === '#') this.comment();
      else if (this.peek() === '\n' || this.peek() === '\r') this.at++;
      else return;
    }
  }

  comment(): void {
    while (!this.done && this.peek() !== '\n') this.at++;
  }

  endOfLine(): void {
    this.blank();
    if (this.peek() === '#') this.comment();
    if (this.peek() === '\r') this.at++;
    if (!this.done && this.peek() !== '\n') this.fail('expected the end of the line');
    this.at++;
  }

  key(): string[] {
    const parts: string[] = [];
    for (;;) {
      this.blank();
      const c = this.peek();
      if (c === '"' || c === "'") parts.push(this.string());
      else {
        const start = this.at;
        while (BARE_KEY.test(this.peek())) this.at++;
        if (this.at === start) this.fail('expected a key');
        parts.push(this.text.slice(start, this.at));
      }
      this.blank();
      if (this.peek() !== '.') return parts;
      this.at++;
    }
  }

  value(): unknown {
    const c = this.peek();
    if (c === '"' || c === "'") return this.string();
    if (c === '[') return this.array();
    if (c === '{') return this.inlineTable();
    let word = this.word();
    // A date and a time may have a space between them.
    if (/^\d{4}-\d{2}-\d{2}$/.test(word) && this.peek() === ' ' && /\d/.test(this.peek(1))) {
      this.at++;
      word += ` ${this.word()}`;
    }
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word.length === 0) this.fail('expected a value');
    const number = Number(word.replace(/_/g, ''));
    // A date or a time is kept as written: nothing here reads one.
    return /^[+-]?(\d|inf|nan)/.test(word) && !Number.isNaN(number) ? number : word;
  }

  private word(): string {
    const start = this.at;
    while (/[A-Za-z0-9_:.+-]/.test(this.peek())) this.at++;
    return this.text.slice(start, this.at);
  }

  private string(): string {
    const quote = this.peek();
    const triple = this.text.startsWith(quote.repeat(3), this.at);
    this.at += triple ? 3 : 1;
    // A line break right after the opening quotes is not part of the text.
    if (triple && this.peek() === '\r') this.at++;
    if (triple && this.peek() === '\n') this.at++;
    let out = '';
    for (;;) {
      if (this.done) this.fail('a string is not closed');
      const c = this.peek();
      if (!triple && c === '\n') this.fail('a string is not closed on its line');
      if (this.text.startsWith(triple ? quote.repeat(3) : quote, this.at)) {
        this.at += triple ? 3 : 1;
        return out;
      }
      if (quote === '"' && c === '\\') {
        out += this.escape(triple);
        continue;
      }
      out += c;
      this.at++;
    }
  }

  private escape(triple: boolean): string {
    this.at++;
    const c = this.peek();
    if (triple && (c === '\n' || c === '\r' || c === ' ' || c === '\t')) {
      // A backslash at the end of a line joins it to the next, without the spaces between.
      while (/\s/.test(this.peek())) this.at++;
      return '';
    }
    if (c in ESCAPES) {
      this.at++;
      return ESCAPES[c] ?? '';
    }
    if (c === 'u' || c === 'U') {
      const length = c === 'u' ? 4 : 8;
      const hex = this.text.slice(this.at + 1, this.at + 1 + length);
      if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== length) this.fail('a \\u escape needs hexadecimal digits');
      this.at += 1 + length;
      return String.fromCodePoint(parseInt(hex, 16));
    }
    return this.fail(`unknown escape \\${c}`);
  }

  private array(): unknown[] {
    this.take('[');
    const items: unknown[] = [];
    for (;;) {
      this.space();
      if (this.peek() === ']') break;
      items.push(this.value());
      this.space();
      if (this.peek() === ',') this.at++;
      else if (this.peek() !== ']') this.fail('expected , or ] in an array');
    }
    this.at++;
    return items;
  }

  /** Line breaks and a last comma are let in, as newer TOML allows: a hand-written file may have them. */
  private inlineTable(): TomlTable {
    this.take('{');
    const out = table();
    for (;;) {
      this.space();
      if (this.peek() === '}') break;
      const key = this.key();
      this.take('=');
      this.blank();
      assign(out, key, this.value(), this);
      this.space();
      if (this.peek() === ',') this.at++;
      else if (this.peek() !== '}') this.fail('expected , or } in an inline table');
    }
    this.at++;
    return out;
  }
}

/** The table at `path` under `root`, made when missing; the last one of an array of tables. */
function tableAt(root: TomlTable, path: string[], reader: Reader): TomlTable {
  let current = root;
  for (const part of path) {
    let next = current[part];
    if (next === undefined) {
      next = table();
      current[part] = next;
    }
    if (Array.isArray(next)) next = next.at(-1);
    if (!isTable(next)) reader.fail(`${path.join('.')} is not a table`);
    current = next;
  }
  return current;
}

function assign(target: TomlTable, key: string[], value: unknown, reader: Reader): void {
  const last = key.at(-1) ?? reader.fail('expected a key');
  tableAt(target, key.slice(0, -1), reader)[last] = value;
}

export function parseToml(text: string): TomlTable {
  const reader = new Reader(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  const root = table();
  let current = root;
  for (;;) {
    reader.space();
    if (reader.done) return root;
    if (reader.peek() === '[') {
      const many = reader.peek(1) === '[';
      reader.take(many ? '[[' : '[');
      const path = reader.key();
      reader.take(many ? ']]' : ']');
      if (many) {
        const parent = tableAt(root, path.slice(0, -1), reader);
        const name = path.at(-1) ?? reader.fail('expected a key');
        const list: unknown = parent[name] ?? [];
        if (!Array.isArray(list)) reader.fail(`${path.join('.')} is not an array of tables`);
        current = table();
        (list as unknown[]).push(current);
        parent[name] = list;
      } else {
        current = tableAt(root, path, reader);
      }
    } else {
      const key = reader.key();
      reader.take('=');
      reader.blank();
      assign(current, key, reader.value(), reader);
    }
    reader.endOfLine();
  }
}
