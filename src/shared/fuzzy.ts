/**
 * How well one query word matches a text, or null when it doesn't: a prefix
 * beats a word start, which beats a substring, which beats the letters
 * appearing in order ("tgsb" finds "Toggle sidebar").
 */
function wordScore(word: string, text: string): number | null {
  const at = text.indexOf(word);
  if (at === 0) return 1000 - text.length;
  if (at > 0) return (/[\s:/._-]/.test(text[at - 1] ?? '') ? 800 : 500) - at;
  // The letters in order, from each place the first one appears; the best compact match wins.
  let best: number | null = null;
  for (let first = text.indexOf(word[0] ?? ''); first >= 0; first = text.indexOf(word[0] ?? '', first + 1)) {
    const score = inOrder(word, text, first);
    // A letter missing after this start is missing after every later one too.
    if (score === 'missing') break;
    if (score !== null && (best === null || score > best)) best = score;
  }
  return best;
}

function inOrder(word: string, text: string, first: number): number | null | 'missing' {
  let from = first;
  let previous = -2;
  let score = 0;
  let starts = 0;
  for (const ch of word) {
    const found = text.indexOf(ch, from);
    if (found < 0) return 'missing';
    const wordStart = found === 0 || /[\s:/._-]/.test(text[found - 1] ?? '');
    if (wordStart) starts++;
    score += found === previous + 1 ? 6 : wordStart ? 4 : 1;
    previous = found;
    from = found + 1;
  }
  // Letters scattered across the whole text match almost anything: keep compact runs and initials ("tgsb").
  if (starts < word.length && previous - first + 1 > word.length * 3) return null;
  return score;
}

/** Scores text against a query: every word of the query has to match, in any order. Null when something doesn't. */
export function fuzzyScore(query: string, text: string): number | null {
  const words = query.toLowerCase().trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return 0;
  const haystack = text.toLowerCase();
  let total = 0;
  for (const word of words) {
    const score = wordScore(word, haystack);
    if (score === null) return null;
    total += score;
  }
  return total;
}

/** Items that match the query, best first, at most `limit`; ties and an empty query keep the original order. */
export function fuzzyFilter<T>(query: string, items: T[], key: (item: T) => string, limit = Infinity): T[] {
  if (query.trim().length === 0) return items.slice(0, limit);
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(query, key(item)) }))
    .filter((x): x is { item: T; index: number; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((x) => x.item);
}
