/** What the Search tab says and sends (pure; unit-tested). */

import { maskSecrets } from '@shared/secrets';
import type { TextSearchQuery, TextSearchResult } from '@shared/schemas/textSearch';

/** The results sent to the agent list this many lines; the rest are counted. */
const MAX_SENT = 200;
/** Selected text longer than this is not what someone means to look for. */
const MAX_SEED = 200;

function counted(count: number, one: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : `${one}s`}`;
}

/** One sentence for what a search found. A search that was stopped never reads as a complete one. */
export function searchSummary(result: TextSearchResult): string {
  const files = counted(result.files.length, 'file');
  if (result.truncated) return result.lines === 0 ? 'The search was stopped before it found anything.' : `The first ${counted(result.lines, 'line')}, in ${files}. There are more: narrow the search.`;
  return result.lines === 0 ? 'No results' : `${counted(result.lines, 'line')} in ${files}`;
}

/** A shown line in pieces: what matched, and what is around it. */
export function pieces(text: string, ranges: Array<[number, number]>): Array<{ text: string; hit: boolean }> {
  const out: Array<{ text: string; hit: boolean }> = [];
  let at = 0;
  for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const start = Math.max(at, Math.min(from, text.length));
    const end = Math.min(to, text.length);
    if (end <= start) continue;
    if (start > at) out.push({ text: text.slice(at, start), hit: false });
    const last = out[out.length - 1];
    // A range that starts where the one before ended (or inside it) is the same mark.
    if (last?.hit && start === at) last.text += text.slice(start, end);
    else out.push({ text: text.slice(start, end), hit: true });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

/** How a search looked, for whoever reads its results without the tab in front of them. */
function described(query: TextSearchQuery): string {
  const how = [query.caseSensitive ? 'case matched' : null, query.wholeWord ? 'whole words' : null, query.files.trim() ? `in ${query.files.trim()}` : null].filter((part): part is string => part !== null);
  return `Search in the project for ${query.regex ? 'the pattern ' : ''}${JSON.stringify(query.text)}${how.length > 0 ? ` (${how.join(', ')})` : ''}`;
}

/**
 * The results as text for the agent: what was looked for, then each line
 * under its file. A line that holds a key or a password is covered, since
 * this text goes to the model.
 */
export function resultsText(query: TextSearchQuery, result: TextSearchResult, limit = MAX_SENT): string {
  const out = [described(query), searchSummary(result)];
  let listed = 0;
  for (const file of result.files) {
    if (listed >= limit) break;
    out.push('', file.path);
    for (const match of file.matches.slice(0, limit - listed)) out.push(`  ${String(match.line)}: ${maskSecrets(match.text)}`);
    listed += Math.min(file.matches.length, limit - listed);
  }
  const more = result.lines - listed;
  if (more > 0) out.push('', `…and ${counted(more, 'more line')}.`);
  return out.join('\n');
}

/** The text that was selected when the search was opened, when it is something to look for: one short line. */
export function seedFromSelection(selected: string): string | null {
  const text = selected.trim();
  return text.length === 0 || text.length > MAX_SEED || /[\r\n]/.test(text) ? null : text;
}
