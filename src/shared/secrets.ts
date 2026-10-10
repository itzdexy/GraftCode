/**
 * Finds API keys, tokens, passwords and private keys in text by their shape
 * and by what they are assigned to, so the transcript can cover them until
 * the user asks to see them. It reads what is shown, nothing more: what a
 * tool printed is stored and sent to the model unchanged.
 *
 * Every pattern is bounded, and private keys are walked line by line, so a
 * long line built against a pattern costs time in proportion to its length.
 * Pure, so it is unit-tested without a DOM.
 */

/** A secret in a text, from `start` up to but not including `end`. */
export interface SecretSpan {
  start: number;
  end: number;
  /** How many of its first characters stay readable while it is covered: a vendor's prefix tells keys apart, a password shows nothing. */
  keep: number;
}

/** A vendor's key keeps this much of its start ("sk-ant", "ghp_A1"). */
const PREFIX = 6;

/** Keys that are recognizable on their own; the whole match is the secret. */
const SHAPES: RegExp[] = [
  // GitHub (personal, OAuth, user-to-server, server-to-server, refresh; fine-grained) and GitLab.
  /\bgh[pousr]_[A-Za-z0-9]{30,255}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,255}/g,
  /\bglpat-[A-Za-z0-9_-]{20,255}/g,
  // AWS access key ids, Google API keys, Slack, Stripe, Hugging Face, npm.
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{35}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,255}/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,255}/g,
  /\bhf_[A-Za-z0-9]{30,255}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  // A signed web token: three base64url parts, the first two being JSON.
  /\beyJ[A-Za-z0-9_-]{8,300}\.eyJ[A-Za-z0-9_-]{8,4000}\.[A-Za-z0-9_-]{8,1000}/g
];

/** Anthropic, OpenRouter, OpenAI and the many services that copied "sk-". Checked further: a branch may be named "sk-…" too. */
const SK = /\bsk-(?:ant-|or-|proj-|svcacct-)?([A-Za-z0-9_-]{24,512})/g;

/** A key is random: digits among its letters. "sk-refactor-transcript-view-menu" is a name. */
function randomEnough(body: string): boolean {
  return (body.match(/[0-9]/g)?.length ?? 0) >= 3;
}

/** `name = value`, `"name": "value"`, `name: value`, with or without quotes and JSON's escaped quotes. Groups: the value's opening quote, the value. */
const ASSIGN = String.raw`\\?["']?\s{0,8}[:=]\s{0,8}(\\?["']?)`;

/** Names whose value is a secret. The name ends in the telling word, so MAX_TOKENS and tokenLimit don't count. */
const NAMED = new RegExp(String.raw`(?:api[_-]?key|access[_-]?key|secret[_-]?key|account[_-]?key|private[_-]?key|secret|token|password|passwd)${ASSIGN}([A-Za-z0-9+/_=-]{16,512})(?![A-Za-z0-9+/_=(.[-])`, 'gi');
/** Passwords are shorter and use any character; the value runs to the next blank or quote. */
const PASSWORD = new RegExp(String.raw`(?:password|passwd)${ASSIGN}([^\s"'\`\\]{8,256})`, 'gi');
/** An AWS secret key is forty base64 characters, whatever they look like. */
const AWS_SECRET = new RegExp(String.raw`aws_secret_access_key${ASSIGN}([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])`, 'gi');
/** An environment variable whose name has KEY, SECRET, TOKEN, PASSWORD or CREDENTIALS as one of its words: `SECRET_KEY=…`, `DISCORD_TOKEN=a.b.c`. */
const ENV = /\b(?:[A-Z][A-Z0-9]*_)*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?)(?:_[A-Z0-9]+)*=(\\?["']?)([^\s"'`\\]{8,512})/g;
/** `Authorization: Bearer …`. */
const BEARER = /\b(?:Bearer|Basic)\s{1,8}([A-Za-z0-9._~+/=-]{24,2048})/g;
/** The password in an address: `postgres://admin:PASSWORD@host`. */
const URL_PASSWORD = /[a-z][a-z0-9+.-]{1,20}:\/\/[^\s/:@]{1,128}:([^\s/@]{3,256})@/gi;

/** A value under a telling name counts when it mixes letters and digits: not a word, a number or a type. */
function mixed(value: string): boolean {
  return /[A-Za-z]/.test(value) && /[0-9]/.test(value);
}

/**
 * Code, not a secret: a call, a template, a path, and (`chains`) a chain of
 * properties such as `settings.apiKey1`. An environment variable is not
 * checked for chains: its value is text, and tokens come with dots in them.
 */
function looksLikeCode(value: string, chains: boolean): boolean {
  if (/[(){}]|\$\{|^\$\(/.test(value) || /^(?:\.{0,2}|~)[\\/]/.test(value) || /^[A-Za-z]:[\\/]/.test(value)) return true;
  return chains && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value);
}

const KEY_BEGIN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g;
const KEY_END = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g;
const KEY_END_LINE = /^-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;
/** A full line of key material, a short last line, and the "Name: value" lines an armoured key may open with. */
const KEY_LINE = /^[A-Za-z0-9+/]{16,}={0,2}$/;
const KEY_TAIL = /^[A-Za-z0-9+/=]{1,15}$/;
const KEY_HEADER = /^[A-Za-z][A-Za-z-]{0,30}: .{0,200}$/;
/** How far from a key's first or last line its material is looked for. */
const KEY_REACH = 64_000;

/**
 * Private keys. A whole one is covered from its first line to its last. One
 * whose last line is missing (the output was cut) is covered as far as its
 * key material goes, and one whose first line is missing (only the end of an
 * output is shown) from where that material starts. A first line quoted on
 * its own, as in a search result, covers nothing, and so do a first and a
 * last line with ordinary text between them.
 */
function privateKeys(text: string): SecretSpan[] {
  const spans: SecretSpan[] = [];
  let covered = 0;
  for (const begin of text.matchAll(KEY_BEGIN)) {
    if (begin.index < covered) continue;
    const from = begin.index + begin[0].length;
    const lines = text.slice(from, from + KEY_REACH).split('\n');
    // lines[0] is what is left of the first line (nothing, or a carriage return).
    let at = from + (lines[0]?.length ?? 0);
    let end = -1;
    let material = false;
    for (let i = 1; i < lines.length; i++) {
      const raw = lines[i] ?? '';
      const line = raw.trim();
      const lineEnd = at + 1 + raw.length;
      const last = KEY_END_LINE.exec(line);
      if (last) {
        if (material) end = at + 1 + raw.indexOf(last[0]) + last[0].length;
        break;
      }
      if (KEY_LINE.test(line)) {
        material = true;
        end = at + 1 + raw.trimEnd().length;
      } else if (material ? !(KEY_TAIL.test(line) && KEY_END_LINE.test((lines[i + 1] ?? '').trim())) : !(line === '' || KEY_HEADER.test(line))) {
        break;
      }
      at = lineEnd;
    }
    if (end > 0) {
      spans.push({ start: begin.index, end, keep: 0 });
      covered = end;
    }
  }
  // A last line with no first line before it: the lines of key material above it are what is left of a key.
  for (const last of text.matchAll(KEY_END)) {
    if (spans.some((span) => last.index >= span.start && last.index < span.end)) continue;
    const before = text.slice(Math.max(0, last.index - KEY_REACH), last.index).split('\n');
    let start = last.index;
    let at = last.index - (before.at(-1)?.length ?? 0);
    let material = false;
    for (let i = before.length - 2; i >= 0; i--) {
      const raw = before[i] ?? '';
      const line = raw.trim();
      if (!(KEY_LINE.test(line) || (!material && KEY_TAIL.test(line)))) break;
      at -= raw.length + 1;
      material ||= KEY_LINE.test(line);
      start = at + (raw.length - raw.trimStart().length);
    }
    if (material) spans.push({ start, end: last.index + last[0].length, keep: 0 });
  }
  return spans;
}

/** The value of a named pattern as a span; `value` is the pattern's last group. */
function valueSpan(match: RegExpMatchArray, value: string): SecretSpan {
  const start = match.index! + match[0].lastIndexOf(value);
  return { start, end: start + value.length, keep: 0 };
}

/** Every secret in `text`, in order, without overlaps. */
export function findSecrets(text: string): SecretSpan[] {
  const found: SecretSpan[] = privateKeys(text);
  for (const shape of SHAPES) {
    for (const match of text.matchAll(shape)) found.push({ start: match.index, end: match.index + match[0].length, keep: PREFIX });
  }
  for (const match of text.matchAll(SK)) {
    if (randomEnough(match[1] ?? '')) found.push({ start: match.index, end: match.index + match[0].length, keep: PREFIX });
  }
  for (const match of text.matchAll(AWS_SECRET)) found.push(valueSpan(match, match[2] ?? ''));
  for (const match of text.matchAll(BEARER)) {
    if (mixed(match[1] ?? '')) found.push(valueSpan(match, match[1] ?? ''));
  }
  for (const match of text.matchAll(URL_PASSWORD)) found.push(valueSpan(match, match[1] ?? ''));
  for (const match of text.matchAll(NAMED)) {
    const value = match[2] ?? '';
    const quoted = (match[1] ?? '').length > 0;
    // Unquoted and followed by code's punctuation, it is an identifier being assigned; a path is a path.
    const next = text[match.index + match[0].length] ?? '';
    if (!mixed(value) || looksLikeCode(value, true) || (!quoted && (next === ';' || next === ',' || next === ')'))) continue;
    found.push(valueSpan(match, value));
  }
  for (const pattern of [PASSWORD, ENV]) {
    for (const match of text.matchAll(pattern)) {
      // What follows a value on its line is punctuation, not part of it.
      const value = (match[2] ?? '').replace(/[,;]+$/, '');
      if (value.length < 8 || !mixed(value) || looksLikeCode(value, pattern === PASSWORD)) continue;
      found.push(valueSpan(match, value));
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: SecretSpan[] = [];
  for (const span of found) {
    const last = merged.at(-1);
    if (last && span.start < last.end) {
      // Two patterns found the same secret: one cover, with the vendor's prefix when both start at it.
      if (span.start === last.start) last.keep = Math.max(last.keep, span.keep);
      last.end = Math.max(last.end, span.end);
    } else merged.push({ ...span });
  }
  return merged;
}

const DOTS = '••••••••';

/** A part of a text as it is shown: plain, or a secret with what it shows while covered (`cover`: the same eight dots whatever its length). */
export interface ShownPiece {
  text: string;
  secret: boolean;
  cover: string;
}

/**
 * The last `count` lines of a text already cut into pieces. A long output is
 * folded after its secrets are found, never before: a private key is known by
 * its first line, and the lines that are kept may not include it.
 */
export function lastLines(pieces: ShownPiece[], count: number): ShownPiece[] {
  const text = pieces.map((piece) => piece.text).join('');
  let from = text.length;
  for (let i = 0; i < count; i++) {
    from = text.lastIndexOf('\n', from - 1);
    if (from === -1) return pieces;
  }
  const cut = from + 1;
  const kept: ShownPiece[] = [];
  let start = 0;
  for (const piece of pieces) {
    const end = start + piece.text.length;
    if (start >= cut) kept.push(piece);
    else if (end > cut) {
      const rest = piece.text.slice(cut - start);
      kept.push({ text: rest, secret: piece.secret, cover: piece.secret ? piece.cover : rest });
    }
    start = end;
  }
  return kept;
}

/** `text` cut into the plain parts and the secrets between them. */
export function splitSecrets(text: string): ShownPiece[] {
  const pieces: ShownPiece[] = [];
  let at = 0;
  for (const span of findSecrets(text)) {
    if (span.start > at) {
      const plain = text.slice(at, span.start);
      pieces.push({ text: plain, secret: false, cover: plain });
    }
    const secret = text.slice(span.start, span.end);
    pieces.push({ text: secret, secret: true, cover: `${secret.slice(0, span.keep)}${DOTS}` });
    at = span.end;
  }
  if (at < text.length) {
    const plain = text.slice(at);
    pieces.push({ text: plain, secret: false, cover: plain });
  }
  return pieces;
}

/**
 * The lines of `text` as they read while its secrets are covered, for a text
 * that is shown line by line (a diff), with which of them changed. A secret
 * that runs over several lines, as a private key does, is covered on each.
 */
export function coveredLines(text: string): { lines: string[]; covered: boolean[] } {
  const lines = [''];
  const covered = [false];
  for (const piece of splitSecrets(text)) {
    piece.text.split('\n').forEach((part, i) => {
      if (i > 0) {
        lines.push('');
        covered.push(false);
      }
      const at = lines.length - 1;
      if (!piece.secret) lines[at] += part;
      else if (part.length > 0) {
        // What stays readable of a secret (a vendor's prefix) is at its start: on its first line only.
        lines[at] += i === 0 ? piece.cover : DOTS;
        covered[at] = true;
      }
    });
  }
  return { lines, covered };
}

/** `text` with every secret in it covered. */
export function maskSecrets(text: string): string {
  return splitSecrets(text)
    .map((piece) => piece.cover)
    .join('');
}
