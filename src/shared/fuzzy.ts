/**
 * Subsequence fuzzy match with bonuses for word starts and consecutive
 * characters. Returns null when `query` is not a subsequence of `text`.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (q.length === 0) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    const prev = found > 0 ? t[found - 1] : ' ';
    const boundary = prev === undefined || /[\s/\\._\-:]/.test(prev);
    streak = found === ti ? streak + 1 : 0;
    score += 1 + (boundary ? 3 : 0) + streak * 2 - Math.min(found - ti, 5) * 0.2;
    ti = found + 1;
  }
  // Prefer shorter texts and matches near the start.
  return score - text.length * 0.01;
}

/** Ranks items by fuzzy score (best first), dropping non-matches. */
export function fuzzyFilter<T>(query: string, items: T[], key: (item: T) => string, limit = 50): T[] {
  return items
    .map((item) => ({ item, score: fuzzyScore(query, key(item)) }))
    .filter((r): r is { item: T; score: number } => r.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.item);
}
