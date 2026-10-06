import { linkState, sourcesOf, type LinkState, type Source, type SourceIndex } from '@shared/sources';
import type { ToolCall } from './transcriptModel';

/** What a citation says about its page, in its tooltip and its accessible name. */
export function citationNote(state: LinkState): string {
  switch (state) {
    case 'read':
      return 'Opened in this conversation';
    case 'found':
      return 'Found by a search, not opened';
    case 'unseen':
      return 'Not opened or found in this conversation';
  }
}

/** How a cited page was seen. Null in a conversation with no sources at all: there, nothing is marked. */
export function citationState(href: string, index: SourceIndex | null): LinkState | null {
  return index ? linkState(href, index) : null;
}

export function sourcesHeading(count: number): string {
  return count === 1 ? 'Read 1 page' : `Read ${String(count)} pages`;
}

/** The pages a turn's calls read, once each, in the order they were opened. */
export function turnSources(calls: ToolCall[]): Source[] {
  return sourcesOf(calls.map((call) => ({ content: call.result ? [call.result] : [] }))).filter((source) => source.state === 'read');
}

/** How many pages the card shows before it asks; a research turn can read dozens. */
export const SOURCES_SHOWN = 8;
