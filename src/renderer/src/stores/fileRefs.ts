import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { invoke } from '../lib/ipc';

export const REF_BATCH = 200;
export const REF_DELAY_MS = 50;

/**
 * Collects the names asked about for `delayMs`, then asks about each session's
 * names together, `max` at a time. A reply with hundreds of code spans costs a
 * few requests, not one a span. A batch that fails answers "no file" for all
 * of its names, so nothing waits for ever.
 */
export function createRefBatcher(
  resolve: (sessionId: string, paths: string[]) => Promise<Array<string | null>>,
  answer: (sessionId: string, path: string, resolved: string | null) => void,
  delayMs = REF_DELAY_MS,
  max = REF_BATCH
): { ask(sessionId: string, path: string): void } {
  let waiting = new Map<string, Set<string>>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const send = (sessionId: string, batch: string[]): void => {
    const none = (): void => batch.forEach((path) => answer(sessionId, path, null));
    try {
      resolve(sessionId, batch).then((found) => batch.forEach((path, i) => answer(sessionId, path, found[i] ?? null)), none);
    } catch {
      none();
    }
  };
  const flush = (): void => {
    timer = null;
    const asked = waiting;
    waiting = new Map();
    for (const [sessionId, paths] of asked) {
      const all = [...paths];
      for (let i = 0; i < all.length; i += max) send(sessionId, all.slice(i, i + max));
    }
  };
  return {
    ask(sessionId, path) {
      const paths = waiting.get(sessionId) ?? new Set<string>();
      waiting.set(sessionId, paths.add(path));
      timer ??= setTimeout(flush, delayMs);
    }
  };
}

interface FileRefsState {
  /** By session, then by the path as written: the project file it names, or null when it names none. */
  known: Record<string, Record<string, string | null>>;
  ask: (sessionId: string, path: string) => void;
  /** Drops what was learned about a session: files are made and deleted while a turn runs. */
  forget: (sessionId: string) => void;
}

export const useFileRefs = create<FileRefsState>((set, get) => {
  /** Names asked about and not answered yet, as `<session>\n<path>`. */
  const asked = new Set<string>();
  /** How often each session's answers were dropped. An answer to a question from before the last time is out of date. */
  const dropped = new Map<string, number>();
  /** Sessions whose next question should have the project's file list read again. */
  const stale = new Set<string>();
  const tag = (sessionId: string): string => `${String(dropped.get(sessionId) ?? 0)}:${sessionId}`;
  const untag = (tagged: string): { round: number; sessionId: string } => {
    const at = tagged.indexOf(':');
    return { round: Number(tagged.slice(0, at)), sessionId: tagged.slice(at + 1) };
  };
  // The answers of one batch arrive together and are stored together: one update, not one a name.
  let arrived: Array<{ sessionId: string; path: string; resolved: string | null }> = [];
  const store = (): void => {
    const known = { ...get().known };
    for (const { sessionId, path, resolved } of arrived) known[sessionId] = { ...known[sessionId], [path]: resolved };
    arrived = [];
    set({ known });
  };
  const batcher = createRefBatcher(
    (tagged, paths) => {
      const { sessionId } = untag(tagged);
      return invoke('files:resolve', { sessionId, paths, ...(stale.delete(sessionId) ? { fresh: true } : {}) });
    },
    (tagged, path, resolved) => {
      const { round, sessionId } = untag(tagged);
      if (round !== (dropped.get(sessionId) ?? 0)) return;
      asked.delete(`${sessionId}\n${path}`);
      if (arrived.push({ sessionId, path, resolved }) === 1) queueMicrotask(store);
    }
  );
  return {
    known: {},
    ask: (sessionId, path) => {
      const key = `${sessionId}\n${path}`;
      if (asked.has(key) || get().known[sessionId]?.[path] !== undefined) return;
      asked.add(key);
      batcher.ask(tag(sessionId), path);
    },
    forget: (sessionId) => {
      dropped.set(sessionId, (dropped.get(sessionId) ?? 0) + 1);
      stale.add(sessionId);
      for (const key of [...asked]) if (key.startsWith(`${sessionId}\n`)) asked.delete(key);
      set({ known: Object.fromEntries(Object.entries(get().known).filter(([id]) => id !== sessionId)) });
    }
  };
});

/**
 * The project file a written path names: undefined while unknown, null when
 * there is none. Asks on first use. An answer that was dropped stays on screen
 * until the new one is in, so a link does not blink when a turn ends.
 */
export function useResolvedPath(sessionId: string | null, path: string | null): string | null | undefined {
  const value = useFileRefs((s) => (sessionId !== null && path !== null ? s.known[sessionId]?.[path] : undefined));
  const key = `${sessionId ?? ''}\n${path ?? ''}`;
  const [kept, setKept] = useState<{ key: string; value: string | null } | null>(null);
  if (value !== undefined && (kept?.key !== key || kept.value !== value)) setKept({ key, value });
  useEffect(() => {
    if (sessionId !== null && path !== null && value === undefined) useFileRefs.getState().ask(sessionId, path);
  }, [sessionId, path, value]);
  if (sessionId === null || path === null) return null;
  if (value !== undefined) return value;
  return kept?.key === key ? kept.value : undefined;
}
