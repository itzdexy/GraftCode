/**
 * Math in a reply (pure; unit-tested). Models write formulas four ways:
 * `$$…$$`, `\[…\]`, `\(…\)` and `$…$`. The parser is set to read only the
 * first, because a single dollar is far more often a price or a shell
 * variable than a formula, so this rewrites the other three to it and leaves
 * everything that is not clearly math exactly as it was written.
 */

import { scanFences } from './streaming';

/** A mark that only math uses, a short symbol (`x`, `n2`), or a name with one pair of brackets (`f(x)`). */
const MATH_MARK = /[\\^_=+<>{}]/;
const SHORT_SYMBOL = /^[A-Za-z0-9]{1,3}$/;
const NAME_WITH_BRACKETS = /^[A-Za-z][A-Za-z0-9]*\([^()]*\)$/;
const BLANK = /^[ \t]*$/;
/** The rest of a line and the empty lines after it. */
const TO_NEXT_TEXT = /(?:[ \t]*\n)*/y;
/** What starts something this pass has to look at: code, an escape, a dollar. */
const SPECIAL = /[`\\$]/g;

/**
 * Whether what stands between two single dollars is a formula. It is not when
 * it begins or ends with a space (`$5 and $10`), when a digit follows the
 * closing dollar (`$5-$10`), or when it has nothing of math in it (`$HOME/$USER`).
 */
function isFormula(content: string, after: string | undefined): boolean {
  if (content.length === 0 || /^\s|\s$/.test(content) || content.includes('`')) return false;
  if (after !== undefined && /\d/.test(after)) return false;
  return MATH_MARK.test(content) || SHORT_SYMBOL.test(content) || NAME_WITH_BRACKETS.test(content);
}

/** The text of a stretch without fenced code, with its math rewritten. */
function convert(source: string): { text: string; math: boolean } {
  const length = source.length;
  let out = '';
  let math = false;
  let at = 0;
  const lineStart = (index: number): number => source.lastIndexOf('\n', index - 1) + 1;
  const lineEnd = (index: number): number => {
    const end = source.indexOf('\n', index);
    return end === -1 ? length : end;
  };
  /** A formula on lines of its own: between two blank lines, keeping the indent it was written at (a list item's). Answers where to read on. */
  const display = (indent: string, content: string, end: number): number => {
    const body = content.trim().split('\n').map((line) => indent + line.trim()).join('\n');
    out = out.replace(/\s+$/, '');
    out += `${out.length > 0 ? '\n\n' : ''}${indent}$$\n${body}\n${indent}$$`;
    TO_NEXT_TEXT.lastIndex = lineEnd(end);
    TO_NEXT_TEXT.exec(source);
    const next = TO_NEXT_TEXT.lastIndex;
    if (next < length) out += '\n\n';
    math = true;
    return next;
  };

  while (at < length) {
    SPECIAL.lastIndex = at;
    const found = SPECIAL.exec(source);
    const next = found ? found.index : length;
    out += source.slice(at, next);
    at = next;
    if (!found) break;
    const mark = found[0];

    if (mark === '`') {
      // Inline code: a run of backticks, up to the next run of the same length. Nothing in it is math.
      let run = 1;
      while (source.charAt(at + run) === '`') run++;
      let close = -1;
      for (let from = at + run; ; ) {
        const tick = source.indexOf('`', from);
        if (tick === -1) break;
        let closing = 1;
        while (source.charAt(tick + closing) === '`') closing++;
        if (closing === run) {
          close = tick;
          break;
        }
        from = tick + closing;
      }
      const end = close === -1 ? at + run : close + run;
      out += source.slice(at, end);
      at = end;
      continue;
    }

    if (mark === '\\') {
      const opens = source.charAt(at + 1);
      if (opens === '(') {
        // \( … \) on one line.
        const close = source.indexOf('\\)', at + 2);
        const content = close === -1 || close > lineEnd(at) ? '' : source.slice(at + 2, close);
        if (content.trim().length > 0 && !content.includes('`')) {
          out += `$$${content}$$`;
          math = true;
          at = close + 2;
          continue;
        }
      } else if (opens === '[' && BLANK.test(source.slice(lineStart(at), at))) {
        // \[ … \], on lines of its own: in a sentence, "\[1\]" is an escaped bracket.
        const close = source.indexOf('\\]', at + 2);
        const content = close === -1 ? '' : source.slice(at + 2, close);
        if (content.trim().length > 0 && !/\n[ \t]*\n/.test(content) && !content.includes('`') && BLANK.test(source.slice(close + 2, lineEnd(close + 2)))) {
          at = display(source.slice(lineStart(at), at), content, close + 2);
          continue;
        }
      }
      // Any other escape keeps its character: "\$" is a dollar sign, never the start of a formula.
      out += source.slice(at, at + 2);
      at += 2;
      continue;
    }

    if (source.charAt(at + 1) === '$') {
      const close = source.indexOf('$$', at + 2);
      if (close === -1) {
        // Never closed: text. Escaped, because the parser would take a line that begins with it for the start of a formula.
        out += '\\$\\$';
        at += 2;
        continue;
      }
      const content = source.slice(at + 2, close);
      math = true;
      const before = source.slice(lineStart(at), at);
      if (!content.includes('\n') && content.trim().length > 0 && BLANK.test(before) && BLANK.test(source.slice(close + 2, lineEnd(close + 2)))) {
        // Alone on its line it is meant as a display; written on one line the parser would set it inside a sentence.
        at = display(before, content, close + 2);
        continue;
      }
      out += source.slice(at, close + 2);
      at = close + 2;
      continue;
    }

    // A single dollar: a formula when the next one on its line closes one. Otherwise it is text, and the next may open in its turn.
    const stop = lineEnd(at);
    let close = at + 1;
    while (close < stop && source.charAt(close) !== '$') close += source.charAt(close) === '\\' ? 2 : 1;
    if (close < stop && source.charAt(close + 1) !== '$' && isFormula(source.slice(at + 1, close), source.charAt(close + 1) || undefined)) {
      out += `$$${source.slice(at + 1, close)}$$`;
      math = true;
      at = close + 1;
      continue;
    }
    out += '$';
    at += 1;
  }
  return { text: out, math };
}

/**
 * Rewrites the math in a text to the one form the parser is set to read;
 * `math` says whether there was any. A text without math comes back exactly
 * as it was. Fenced code and inline code are never touched, and neither is a
 * piece that never closes.
 */
export function mathToDollars(text: string): { text: string; math: boolean } {
  if (!text.includes('$') && !text.includes('\\(') && !text.includes('\\[')) return { text, math: false };
  const lines = text.split('\n');
  const fenced = scanFences(lines).inside;
  const out: string[] = [];
  let math = false;
  for (let i = 0; i < lines.length; ) {
    if (fenced[i] === true) {
      out.push(lines[i] ?? '');
      i++;
      continue;
    }
    let end = i;
    while (end < lines.length && fenced[end] !== true) end++;
    const piece = convert(lines.slice(i, end).join('\n'));
    math ||= piece.math;
    out.push(piece.text);
    i = end;
  }
  return math ? { text: out.join('\n'), math } : { text, math: false };
}
