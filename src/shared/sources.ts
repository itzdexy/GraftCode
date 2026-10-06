import type { ContentBlock } from './schemas/messages';

/**
 * What a conversation read and found on the web, worked out from the tool
 * results it already stores. Nothing here is saved: rewind a conversation or
 * delete it, and its sources go with it.
 */

export interface Source {
  /** The address as it was first seen. */
  url: string;
  title: string | null;
  /** read: WebFetch returned the page. found: a search returned it and nothing opened it. */
  state: 'read' | 'found';
  /** Other addresses that led to this page: the one that was asked for, when the page answered from another. */
  aliases?: string[];
}

/** How a link stands to what the conversation saw. */
export type LinkState = 'read' | 'found' | 'unseen';

/** The sources by the one spelling of their address (see normalizeUrl). */
export type SourceIndex = ReadonlyMap<string, 'read' | 'found'>;

/** Parameters that say where a visitor came from, not which page it is. */
const TRACKING = /^(utm_.*|gclid|fbclid)$/i;

/**
 * One spelling for a page's address, so that two links to one page compare
 * equal: https for http, no leading "www.", no fragment, no slash at the end,
 * no tracking parameters. Null unless it is a web address.
 */
export function normalizeUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.host.toLowerCase().replace(/^www\./, '');
  const path = parsed.pathname.replace(/\/+$/, '');
  const kept = [...parsed.searchParams].filter(([name]) => !TRACKING.test(name));
  return `https://${host}${path}${kept.length > 0 ? `?${new URLSearchParams(kept).toString()}` : ''}`;
}

/**
 * The pages a conversation's messages read and found, each once, in the order
 * they were first seen. A page counts as read when WebFetch returned it with a
 * status below 400, and as found when a search (WebSearch, or a provider's
 * own) returned it; the agents of a group count like the main agent. A page
 * found and later read is read, under the title the page itself gave.
 */
export function sourcesOf(messages: Array<{ content: ContentBlock[] }>): Source[] {
  const pages = new Map<string, Source>();
  const see = (url: string, title: string | null, state: Source['state'], asked?: string): void => {
    const key = normalizeUrl(url);
    if (key === null) return;
    let known = pages.get(key);
    if (!known) {
      known = { url, title, state };
      pages.set(key, known);
    } else if (state === 'read') {
      // The page's own title is better than the one a search gave it; a read never turns back into a find.
      if (known.state === 'found' || known.title === null) known.title = title ?? known.title;
      known.state = 'read';
    }
    // A link to the address that was asked for is a link to this page too.
    const alias = asked === undefined ? null : normalizeUrl(asked);
    if (asked !== undefined && alias !== null && alias !== key && !(known.aliases ?? []).some((a) => normalizeUrl(a) === alias)) known.aliases = [...(known.aliases ?? []), asked];
  };
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        const display = block.display;
        if (display?.kind === 'fetch' && display.status < 400 && !block.isError) see(display.url, display.title, 'read', display.requested);
        if (display?.kind === 'web-search') for (const result of display.results) see(result.url, result.title, 'found');
        // What the agents of a group read and found counts as the conversation's own.
        if (display?.kind === 'agents') for (const source of display.sources ?? []) see(source.url, source.title, source.state);
      } else if (block.type === 'provider') {
        for (const result of block.search?.results ?? []) see(result.url, result.title, 'found');
      }
    }
  }
  return [...pages.values()];
}

export function sourceIndex(sources: Source[]): SourceIndex {
  const index = new Map<string, Source['state']>();
  for (const source of sources) {
    for (const url of [source.url, ...(source.aliases ?? [])]) {
      const key = normalizeUrl(url);
      if (key !== null) index.set(key, source.state);
    }
  }
  return index;
}

/** Whether the conversation opened the page a link points to, only found it, or never saw it. */
export function linkState(url: string, index: SourceIndex): LinkState {
  const key = normalizeUrl(url);
  return (key !== null ? index.get(key) : undefined) ?? 'unseen';
}
