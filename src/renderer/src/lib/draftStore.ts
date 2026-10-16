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

/**
 * Remembers which drafts hold text typed in private. A draft is flagged the
 * moment text is set for it in private (an incognito chat, or Chat home while
 * its incognito switch is on) and stays flagged until it is emptied, so it
 * cannot reach storage after the switch goes off or the chat is deleted.
 */
export function trackPrivate(flagged: Set<string>, key: string, text: string, privateNow: boolean): void {
  if (text.length === 0) flagged.delete(key);
  else if (privateNow) flagged.add(key);
}

/**
 * Whether a draft may be stored: never one typed in private; a home draft
 * always; a session's only while that session is known and not incognito.
 * A session nobody knows is refused (its chat may have been incognito and is
 * gone), unless its draft came from storage at start, before the sessions
 * were loaded.
 */
export function mayStore(
  key: string,
  flagged: ReadonlySet<string>,
  sessions: Readonly<Record<string, { incognito: boolean } | undefined>>,
  storedAtStart: ReadonlySet<string>
): boolean {
  if (flagged.has(key)) return false;
  if (key.startsWith('home:')) return true;
  const session = sessions[key];
  return session ? !session.incognito : storedAtStart.has(key);
}
