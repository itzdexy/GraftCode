/** Finding text in what a transcript shows (pure; unit-tested). The page's text comes in as plain strings. */

/** No more matches than this are marked; the count then reads "1,000+". */
export const FIND_MAX = 1000;

/** A place in the text: `node` is the text node's place among all of them, in order. */
export interface FindPoint {
  node: number;
  offset: number;
}

export interface FindMatch {
  start: FindPoint;
  end: FindPoint;
}

/**
 * Lower case that keeps every character where it was. A few letters grow in
 * lower case ("İ" becomes two characters); those are left as they are, so a
 * place in the folded text is the same place in the text on the page.
 */
function fold(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let out = '';
  for (const unit of text.split('')) {
    const one = unit.toLowerCase();
    out += one.length === 1 ? one : unit;
  }
  return out;
}

/**
 * Every place `query` occurs, ignoring case, as typed (no patterns), one
 * after another without overlap. `blocks` holds the text nodes of each block
 * of the page, in order: a match may run across the nodes of one block (a
 * word drawn in several coloured pieces) and never across two blocks. A match
 * begins in the node that holds its first character and ends in the node that
 * holds its last. `more` says that there were more than `max`.
 */
export function findMatches(blocks: ReadonlyArray<ReadonlyArray<string>>, query: string, max = FIND_MAX): { matches: FindMatch[]; more: boolean } {
  const matches: FindMatch[] = [];
  const needle = fold(query);
  if (needle.length === 0) return { matches, more: false };
  let first = 0;
  for (const nodes of blocks) {
    // Where each node begins in the block's text; one more entry for where the last one ends.
    const starts: number[] = [];
    let length = 0;
    for (const node of nodes) {
      starts.push(length);
      length += node.length;
    }
    starts.push(length);
    const text = fold(nodes.join(''));
    let node = 0;
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
      if (matches.length === max) return { matches, more: true };
      const end = at + needle.length;
      // Matches come in order, so the search for a node goes on from the last one found.
      while ((starts[node + 1] ?? length) <= at) node++;
      let last = node;
      while ((starts[last + 1] ?? length) < end) last++;
      matches.push({ start: { node: first + node, offset: at - (starts[node] ?? 0) }, end: { node: first + last, offset: end - (starts[last] ?? 0) } });
    }
    first += nodes.length;
  }
  return { matches, more: false };
}

/** What the bar shows beside the box: "3 of 17", "No results" or "1,000+". `current` counts from 0. */
export function countLabel(current: number, total: number, more: boolean): string {
  if (total === 0) return 'No results';
  if (more) return `${total.toLocaleString('en-US')}+`;
  return `${(current + 1).toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`;
}

/** The match after or before the current one, going round at the ends. */
export function stepMatch(current: number, total: number, direction: 1 | -1): number {
  return total === 0 ? 0 : (current + direction + total) % total;
}
