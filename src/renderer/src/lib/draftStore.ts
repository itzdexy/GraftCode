/**
 * Unsent text of each message box, kept in this window's local storage so
 * closing Graft does not lose what was being typed. Incognito chats are
 * never written here (the caller says which drafts may be kept).
 */
const KEY = 'graft.drafts';
/** The newest drafts kept; older ones belong to sessions long left alone. */
export const MAX_DRAFTS = 50;
/** A longer draft is not kept: storage is small, and pasting a file is what attachments are for. */
export const MAX_DRAFT_LENGTH = 100_000;

/** The drafts worth storing: allowed by `keep`, not empty, not huge, and at most the newest MAX_DRAFTS (the last ones set). */
export function draftsToStore(drafts: Record<string, string>, keep: (key: string) => boolean): Record<string, string> {
  const entries = Object.entries(drafts).filter(([key, text]) => text.length > 0 && text.length <= MAX_DRAFT_LENGTH && keep(key));
  return Object.fromEntries(entries.slice(-MAX_DRAFTS));
}

export function loadDrafts(): Record<string, string> {
  // Outside a window (the unit tests) there is nothing stored, and asking would only draw a warning.
  if (typeof window === 'undefined') return {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0));
  } catch {
    return {};
  }
}

export function saveDrafts(drafts: Record<string, string>, keep: (key: string) => boolean): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify(draftsToStore(drafts, keep)));
  } catch {
    // rocky: drafts are a convenience; when storage is full or unavailable they last only until the window closes.
  }
}
