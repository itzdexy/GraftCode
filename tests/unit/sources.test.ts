import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '../../src/shared/schemas/messages';
import { linkState, normalizeUrl, sourceIndex, sourcesOf } from '../../src/shared/sources';

const fetched = (url: string, status = 200, title: string | null = 'A page'): ContentBlock => ({
  type: 'tool_result',
  toolUseId: 't',
  isError: status >= 400,
  content: [],
  display: { kind: 'fetch', url, status, bytes: 10, title }
});
const searched = (...urls: string[]): ContentBlock => ({
  type: 'tool_result',
  toolUseId: 's',
  isError: false,
  content: [],
  display: { kind: 'web-search', query: 'q', results: urls.map((url) => ({ title: `Result ${url}`, url })) }
});
const native = (url: string): ContentBlock => ({ type: 'provider', provider: 'anthropic', raw: {}, summary: '', search: { query: '', results: [{ title: 'N', url }] } });

describe('the sources of a conversation', () => {
  it('treats the spellings of one address as one page', () => {
    expect(normalizeUrl('HTTP://WWW.Example.com/a/?utm_source=x&id=7&gclid=1#top')).toBe('https://example.com/a?id=7');
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com');
    expect(normalizeUrl('https://example.com/a?fbclid=1&UTM_Medium=mail')).toBe('https://example.com/a');
    expect([normalizeUrl('mailto:a@b.c'), normalizeUrl('not a url'), normalizeUrl('file:///c:/x')]).toEqual([null, null, null]);
  });

  it('lists what was read and what a search found, each page once, a read winning over a find', () => {
    const sources = sourcesOf([
      { content: [searched('https://example.com/a', 'https://example.com/b')] },
      { content: [fetched('http://www.example.com/a/#intro', 200, 'Page A'), fetched('https://example.com/gone', 404)] },
      { content: [native('https://example.org/n'), { type: 'text', text: 'see https://example.com/typed' }] }
    ]);
    expect(sources).toEqual([
      { url: 'https://example.com/a', title: 'Page A', state: 'read' },
      { url: 'https://example.com/b', title: 'Result https://example.com/b', state: 'found' },
      { url: 'https://example.org/n', title: 'N', state: 'found' }
    ]);
    const index = sourceIndex(sources);
    expect(linkState('https://example.com/a/', index)).toBe('read');
    expect(linkState('https://www.example.com/b?utm_medium=x', index)).toBe('found');
    expect(linkState('https://example.com/gone', index)).toBe('unseen');
    expect(linkState('https://example.com/typed', index)).toBe('unseen');
    expect(sourcesOf([{ content: [{ type: 'text', text: 'hi' }] }])).toEqual([]);
  });

  it('keeps a page that was read as read when a later search finds it again, with the title the page gave', () => {
    const sources = sourcesOf([{ content: [fetched('https://example.com/a', 200, 'Page A')] }, { content: [searched('https://example.com/a')] }, { content: [fetched('https://example.com/b', 200, null)] }]);
    expect(sources).toEqual([
      { url: 'https://example.com/a', title: 'Page A', state: 'read' },
      { url: 'https://example.com/b', title: null, state: 'read' }
    ]);
  });
});

describe('a page that answered from another address', () => {
  it('is known by the address that was asked for too', () => {
    const moved: ContentBlock = {
      type: 'tool_result',
      toolUseId: 't',
      isError: false,
      content: [],
      display: { kind: 'fetch', url: 'https://docs.example.com/en/latest/guide', requested: 'https://example.com/guide', status: 200, bytes: 1, title: 'Guide' }
    };
    const sources = sourcesOf([{ content: [moved] }]);
    expect(sources).toEqual([{ url: 'https://docs.example.com/en/latest/guide', title: 'Guide', state: 'read', aliases: ['https://example.com/guide'] }]);
    const index = sourceIndex(sources);
    expect(linkState('https://example.com/guide', index)).toBe('read');
    expect(linkState('https://docs.example.com/en/latest/guide/', index)).toBe('read');
    expect(linkState('https://example.com/other', index)).toBe('unseen');
  });
});
