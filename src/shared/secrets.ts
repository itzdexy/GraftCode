/**
 * Finds API keys, tokens and private keys in text by their shape, so the
 * transcript can cover them until the user asks to see them. It reads what
 * is shown, nothing more: what a tool printed is stored and sent to the
 * model unchanged. Pure, so it is unit-tested without a DOM.
 */

/** A secret in a text, from `start` up to but not including `end`. */
export interface SecretSpan {
  start: number;
  end: number;
}

/** Keys that are recognizable on their own; the whole match is the secret. */
const SHAPES: RegExp[] = [
  // Anthropic, OpenRouter, OpenAI and the many services that copied "sk-".
  /\bsk-(?:ant-|or-|proj-|svcacct-)?[A-Za-z0-9_-]{24,}/g,
  // GitHub: personal, OAuth, user-to-server, server-to-server, refresh; and fine-grained tokens.
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  // AWS access key ids, Google API keys, Slack, Stripe, Hugging Face, npm.
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[A-Za-z0-9_-]{35}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  // A signed web token: three base64url parts, the first two being JSON.
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
];

const KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/g;
/** The lines of a key between its markers: base64, a line each, possibly indented. Read from a bounded stretch after the first line. */
const KEY_BODY = /^(?:\r?\n[ \t]*[A-Za-z0-9+/=]{16,}[ \t]*)+/;
const KEY_BODY_REACH = 20_000;

/**
 * Private keys, from their first line to their last. A key whose last line is
 * missing (the output was cut) is covered as far as its key material goes; a
 * first line quoted on its own, as in a search result, covers nothing.
 * Scanned by hand: one pattern for the whole block would read to the end of
 * the text again for every first line that has no last line.
 */
function privateKeys(text: string): SecretSpan[] {
  const spans: SecretSpan[] = [];
  let covered = 0;
  let endsLeft = true;
  for (const begin of text.matchAll(KEY_BEGIN)) {
    if (begin.index < covered) continue;
    const after = begin.index + begin[0].length;
    let end: RegExpExecArray | null = null;
    if (endsLeft) {
      KEY_END.lastIndex = after;
      end = KEY_END.exec(text);
      // No last line after this first line means none after any later one either.
      if (!end) endsLeft = false;
    }
    if (end) {
      covered = end.index + end[0].length;
      spans.push({ start: begin.index, end: covered });
      continue;
    }
    const body = KEY_BODY.exec(text.slice(after, after + KEY_BODY_REACH));
    if (body) {
      covered = after + body[0].trimEnd().length;
      spans.push({ start: begin.index, end: covered });
    }
  }
  return spans;
}

/** A value is a secret because of what it is assigned to; the first group is the value. */
const NAMED: RegExp[] = [
  /\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{24,})/g,
  // KEY=value, "secret": "value", password: value. The name ends in the telling word, so MAX_TOKENS and tokenLimit don't count.
  // A value that goes on into "(", "." or "[" is code (a call, a property), not a secret, so the value has to end before one.
  /(?:api[_-]?key|secret|token|password|passwd|private[_-]?key)["']?\s*[:=]\s*["']?([A-Za-z0-9+/_=-]{16,})(?![A-Za-z0-9+/_=(.[-])/gi,
  // Passwords are shorter and use more characters.
  /(?:password|passwd)["']?\s*[:=]\s*["']?([A-Za-z0-9!@#%^&*+/_=~-]{8,})(?![A-Za-z0-9!@#%^&*+/_=~(.[-])/gi
];

/** A value under a telling name counts when it mixes letters and digits: not a word, a number or a path. */
function looksRandom(value: string): boolean {
  return /[A-Za-z]/.test(value) && /[0-9]/.test(value);
}

/** Every secret in `text`, in order, without overlaps. */
export function findSecrets(text: string): SecretSpan[] {
  const found: SecretSpan[] = privateKeys(text);
  for (const shape of SHAPES) {
    for (const match of text.matchAll(shape)) found.push({ start: match.index, end: match.index + match[0].length });
  }
  for (const named of NAMED) {
    for (const match of text.matchAll(named)) {
      const value = match[1];
      if (value === undefined || !looksRandom(value)) continue;
      const start = match.index + match[0].lastIndexOf(value);
      found.push({ start, end: start + value.length });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: SecretSpan[] = [];
  for (const span of found) {
    const last = merged.at(-1);
    if (last && span.start < last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/** How much of a secret stays readable, so one key can be told from another. */
const KEEP = 6;
const DOTS = '••••••••';

/** A secret as shown while covered: its first characters, then the same eight dots whatever its length. */
export function coverSecret(secret: string): string {
  return `${secret.slice(0, KEEP)}${DOTS}`;
}

/** `text` cut into the plain parts and the secrets between them. */
export function splitSecrets(text: string): Array<{ text: string; secret: boolean }> {
  const pieces: Array<{ text: string; secret: boolean }> = [];
  let at = 0;
  for (const span of findSecrets(text)) {
    if (span.start > at) pieces.push({ text: text.slice(at, span.start), secret: false });
    pieces.push({ text: text.slice(span.start, span.end), secret: true });
    at = span.end;
  }
  if (at < text.length) pieces.push({ text: text.slice(at), secret: false });
  return pieces;
}

/** `text` with every secret in it covered. */
export function maskSecrets(text: string): string {
  return splitSecrets(text)
    .map((piece) => (piece.secret ? coverSecret(piece.text) : piece.text))
    .join('');
}
