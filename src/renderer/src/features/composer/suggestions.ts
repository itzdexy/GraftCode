import { useEffect, useMemo, useState } from 'react';
import type { SlashCommand } from '@shared/schemas/app';
import { fuzzyScore } from '@shared/fuzzy';
import { invoke } from '../../lib/ipc';
import { logError } from '../../lib/log';

/** The "/command" or "@file" token being typed at the caret, if any. */
export interface Token {
  kind: 'slash' | 'mention';
  query: string;
  /** Replace text[start, end) when a suggestion is chosen. */
  start: number;
  end: number;
}

export function detectToken(text: string, caret: number): Token | null {
  const before = text.slice(0, caret);
  const slash = /^\/([A-Za-z0-9_:-]*)$/.exec(before);
  if (slash) return { kind: 'slash', query: slash[1] ?? '', start: 0, end: caret + (/^[A-Za-z0-9_:-]*/.exec(text.slice(caret))?.[0].length ?? 0) };
  const mention = /(^|\s)@([^\s@"]*)$/.exec(before);
  if (mention) {
    const start = before.length - (mention[2] ?? '').length - 1;
    const rest = /^[^\s]*/.exec(text.slice(caret))?.[0].length ?? 0;
    return { kind: 'mention', query: mention[2] ?? '', start, end: caret + rest };
  }
  return null;
}

/** What an "@" row names, drawn as its icon. */
export type MentionKind = 'file' | 'folder' | 'diff' | 'problems' | 'terminal' | 'url';

export interface Suggestion {
  key: string;
  label: string;
  detail: string | null;
  /** Text that replaces the token. */
  insert: string;
  /** Enter sends right away (commands without arguments). */
  sendOnEnter: boolean;
  /** An "@" row's kind; commands have none. */
  kind?: MentionKind;
}

/**
 * The commands to offer for what was typed after the "/". With nothing typed there is nothing
 * to rank by: every command is listed in the order it was given (the built-in ones as the
 * catalogue orders them, then the user's), and the list scrolls. Once something is typed, the
 * twelve best matches, names that start with it first.
 */
export function commandSuggestions(commands: SlashCommand[], query: string): Suggestion[] {
  const q = query.toLowerCase();
  const matched =
    q === ''
      ? commands
      : commands
          .map((c) => ({ c, score: c.name.startsWith(q) ? 1000 - c.name.length : (fuzzyScore(q, c.name) ?? null) }))
          .filter((x): x is { c: SlashCommand; score: number } => x.score !== null)
          .sort((a, b) => b.score - a.score)
          .slice(0, 12)
          .map(({ c }) => c);
  return matched.map((c) => ({
    key: `${c.source}:${c.name}`,
    label: `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}`,
    detail: c.description,
    insert: c.argumentHint ? `/${c.name} ` : `/${c.name}`,
    sendOnEnter: c.argumentHint === null
  }));
}

function quotePath(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

/** What "@" attaches besides files and folders (agent/mentions.ts in the main process). */
const MENTION_WORDS: Array<{ word: 'diff' | 'problems' | 'terminal'; detail: string }> = [
  { word: 'diff', detail: 'Uncommitted changes in this folder' },
  { word: 'problems', detail: 'Errors and warnings from the Problems tab' },
  { word: 'terminal', detail: 'The last 200 lines of the Terminal panel' }
];

const WEB_ADDRESS = /^https?:\/\/\S+/i;
/** Lines of a file after its path: ":10-40", ":10", or ":10-" while the end is typed. */
const LINE_RANGE = /:\d+(?:-\d*)?$/;

/** What the project index is asked for: the path, without the lines typed after it. */
export function pathQuery(query: string): string {
  return query.replace(LINE_RANGE, '');
}

/**
 * The rows "@" offers for what was typed after it: the words that attach
 * something other than a file, a web page by its address, then the files and
 * folders the project index matched (`paths`, folders ending in "/"). Lines
 * typed after a path stay with the files it matched.
 */
export function mentionSuggestions(query: string, paths: string[]): Suggestion[] {
  if (WEB_ADDRESS.test(query)) return [{ key: 'url', label: query, detail: 'Attach this web page as text', insert: `@${query} `, sendOnEnter: false, kind: 'url' }];
  const q = query.toLowerCase();
  const words = MENTION_WORDS.filter((m) => m.word.startsWith(q)).map(
    (m): Suggestion => ({ key: m.word, label: `@${m.word}`, detail: m.detail, insert: `@${m.word} `, sendOnEnter: false, kind: m.word })
  );
  // Chosen, it leaves "@https://" for the address to be typed after.
  const web: Suggestion[] = 'url'.startsWith(q) ? [{ key: 'url', label: '@url', detail: 'A web page as text: type its address', insert: '@https://', sendOnEnter: false, kind: 'url' }] : [];
  const range = LINE_RANGE.exec(query)?.[0] ?? '';
  const found = paths
    .filter((p) => range === '' || !p.endsWith('/'))
    .slice(0, 12)
    .map((p): Suggestion => ({ key: p, label: `${p}${range}`, detail: null, insert: `@${quotePath(`${p}${range}`)} `, sendOnEnter: false, kind: p.endsWith('/') ? 'folder' : 'file' }));
  return [...words, ...web, ...found];
}

/** Suggestions for the token at the caret: commands from the list, files and folders from the project index. */
export function useSuggestions(token: Token | null, commands: SlashCommand[] | null, mentionRoot: string | null): { items: Suggestion[]; loading: boolean } {
  const [files, setFiles] = useState<{ root: string; query: string; paths: string[] } | null>(null);
  // An address is not looked for among the files.
  const mentionQuery = token?.kind === 'mention' && mentionRoot && !WEB_ADDRESS.test(token.query) ? pathQuery(token.query) : null;

  useEffect(() => {
    if (mentionQuery === null || !mentionRoot) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      invoke('files:search', { root: mentionRoot, query: mentionQuery, folders: true })
        .then((paths) => {
          if (!cancelled) setFiles({ root: mentionRoot, query: mentionQuery, paths });
        })
        .catch((error: unknown) => logError('File search failed', error));
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mentionQuery, mentionRoot]);

  return useMemo(() => {
    if (!token) return { items: [], loading: false };
    if (token.kind === 'slash') return { items: commands ? commandSuggestions(commands, token.query) : [], loading: false };
    if (!mentionRoot) return { items: [], loading: false };
    if (WEB_ADDRESS.test(token.query)) return { items: mentionSuggestions(token.query, []), loading: false };
    // The words are offered at once; the files and folders join them when the index answers.
    if (!files || files.root !== mentionRoot || files.query !== pathQuery(token.query)) return { items: mentionSuggestions(token.query, []), loading: true };
    return { items: mentionSuggestions(token.query, files.paths), loading: false };
  }, [token, commands, mentionRoot, files]);
}
