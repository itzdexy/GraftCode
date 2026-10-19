/** Automatic compaction starts once the context passes this share of the window. */
export const COMPACT_THRESHOLD = 0.8;

/** Tokens left before automatic compaction starts in a window of this size; null when the window is unknown. */
export function tokensUntilCompact(used: number, contextWindow: number): number | null {
  if (contextWindow <= 0) return null;
  return Math.max(0, Math.floor(contextWindow * COMPACT_THRESHOLD) - used);
}
