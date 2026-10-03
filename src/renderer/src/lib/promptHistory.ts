/**
 * Messages the user sent, newest first, for ↑ and ↓ in the message box.
 * Kept in this window's local storage only; incognito chats never add to it.
 */
const KEY = 'graft.prompt.history';
const MAX_ENTRIES = 100;
const MAX_LENGTH = 4000;

export function loadHistory(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').slice(0, MAX_ENTRIES) : [];
  } catch {
    return [];
  }
}

/** Adds a sent message; repeating the newest entry doesn't add a copy. Very long messages aren't kept. */
export function pushHistory(text: string): void {
  const entry = text.trim();
  if (entry.length === 0 || entry.length > MAX_LENGTH) return;
  const history = loadHistory();
  if (history[0] === entry) return;
  try {
    localStorage.setItem(KEY, JSON.stringify([entry, ...history.filter((h) => h !== entry)].slice(0, MAX_ENTRIES)));
  } catch {
    // rocky: history is a convenience; when storage is unavailable nothing is remembered.
  }
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
}
