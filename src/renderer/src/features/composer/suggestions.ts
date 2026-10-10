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

export interface Suggestion {
  key: string;
  label: string;
  detail: string | null;
  /** Text that replaces the token. */
  insert: string;
  /** Enter sends right away (commands without arguments). */
  sendOnEnter: boolean;
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

/** Suggestions for the token at the caret: commands from the list, files from the project index. */
export function useSuggestions(token: Token | null, commands: SlashCommand[] | null, mentionRoot: string | null): { items: Suggestion[]; loading: boolean } {
  const [files, setFiles] = useState<{ root: string; query: string; paths: string[] } | null>(null);
  const mentionQuery = token?.kind === 'mention' && mentionRoot ? token.query : null;

  useEffect(() => {
    if (mentionQuery === null || !mentionRoot) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      invoke('files:search', { root: mentionRoot, query: mentionQuery })
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
    if (!files || files.root !== mentionRoot || files.query !== token.query) return { items: [], loading: true };
    return {
      items: files.paths.slice(0, 12).map((p) => ({ key: p, label: p, detail: null, insert: `@${quotePath(p)} `, sendOnEnter: false })),
      loading: false
    };
  }, [token, commands, mentionRoot, files]);
}
