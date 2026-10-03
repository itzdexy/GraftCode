/**
 * How well one query word matches a text, or null when it doesn't: a prefix
 * beats a word start, which beats a substring, which beats the letters
 * appearing in order ("tgsb" finds "Toggle sidebar").
 */
function wordScore(word: string, text: string): number | null {
  const at = text.indexOf(word);
  if (at === 0) return 1000 - text.length;
  if (at > 0) return (/[\s:/._-]/.test(text[at - 1] ?? '') ? 800 : 500) - at;
  let from = 0;
  let previous = -2;
  let score = 0;
  for (const ch of word) {
    const found = text.indexOf(ch, from);
    if (found < 0) return null;
    const wordStart = found === 0 || /[\s:/._-]/.test(text[found - 1] ?? '');
    score += found === previous + 1 ? 6 : wordStart ? 4 : 1;
    previous = found;
    from = found + 1;
  }
  return score;
}

/** Scores text against a query: every word of the query has to match. Null when something doesn't. */
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

/** Items that match the query, best first; ties keep their original order. */
export function fuzzyFilter<T>(items: T[], query: string, text: (item: T) => string): T[] {
  if (query.trim().length === 0) return items;
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(query, text(item)) }))
    .filter((x): x is { item: T; index: number; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.item);
}
