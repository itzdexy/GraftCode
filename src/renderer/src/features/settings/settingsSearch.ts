import type { SettingsSection } from '../../stores/nav';
import { SETTINGS_SECTIONS } from './sections';
import INDEX from './settingsIndex.json';

/**
 * Search over Settings: its pages and every labelled setting on them. The
 * settings come from settingsIndex.json, which is read out of the pages'
 * own source by tests/unit/renderer/settingsIndex.test.ts, so a setting is
 * found under the words that are written beside it. Pure, so it is
 * unit-tested without a DOM.
 */

/** A place a search can land on: a page, or one setting on a page. */
export interface SettingsHit {
  section: SettingsSection;
  /** The page's name. */
  page: string;
  /** The setting's label as its row shows it; null for the page itself. */
  setting: string | null;
}

interface Page {
  id: SettingsSection;
  label: string;
  description: string;
}

const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 0);

/** A word found only in the name of the page a setting is on, and one found only in a page's description. */
const ON_ITS_PAGE = 2;
const IN_DESCRIPTION = 3;

/**
 * How well a name answers what was asked, lower being better; null when one
 * of the words asked for is nowhere. A word that begins a word of the name
 * costs nothing, one inside the name a little, one found only in `more`
 * costs `elsewhere`. A setting's `more` is its page's name, which says more
 * about it than a page's description says about the page: "appearance theme"
 * is the Theme setting first, the Appearance page second.
 */
function distance(asked: string[], name: string, more: string, elsewhere: number): number | null {
  const inName = wordsOf(name);
  const inMore = wordsOf(more);
  let total = 0;
  for (const word of asked) {
    if (inName.some((w) => w.startsWith(word))) continue;
    if (name.toLowerCase().includes(word)) total += 1;
    else if (inMore.some((w) => w.startsWith(word))) total += elsewhere;
    else return null;
  }
  return total;
}

/** The pages and settings that match `query`, best first; a page before its settings when they match equally. */
export function searchSettings(
  query: string,
  limit = 8,
  pages: readonly Page[] = SETTINGS_SECTIONS,
  index: ReadonlyArray<{ section: string; label: string }> = INDEX
): SettingsHit[] {
  const asked = wordsOf(query);
  if (asked.length === 0) return [];
  const found: Array<{ hit: SettingsHit; score: number }> = [];
  for (const page of pages) {
    const score = distance(asked, page.label, page.description, IN_DESCRIPTION);
    if (score !== null) found.push({ hit: { section: page.id, page: page.label, setting: null }, score });
  }
  for (const entry of index) {
    const page = pages.find((p) => p.id === entry.section);
    if (!page) continue;
    const score = distance(asked, entry.label, page.label, ON_ITS_PAGE);
    if (score !== null) found.push({ hit: { section: page.id, page: page.label, setting: entry.label }, score });
  }
  // The sort is stable: among equals, pages (added first) stay ahead and settings keep the order of their pages.
  return found
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((entry) => entry.hit);
}
