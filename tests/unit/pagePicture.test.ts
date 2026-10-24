import { describe, expect, it } from 'vitest';
import { extractImage } from '../../src/main/tools/web/htmlToText';
import type { ContentBlock } from '../../src/shared/schemas/messages';
import { sourcesOf } from '../../src/shared/sources';

describe('the picture a page offers', () => {
  const page = (head: string): string => `<html><head>${head}</head><body><meta property="og:image" content="https://late.example/x.png"></body></html>`;

  it('reads Open Graph first, then the Twitter card, from the head only', () => {
    expect(extractImage(page('<meta property="og:image" content="https://cdn.example/a.jpg?w=1200&amp;h=630">'), 'https://example.com/p')).toBe('https://cdn.example/a.jpg?w=1200&h=630');
    expect(extractImage(page('<meta name="twitter:image" content="/card.png"><meta content=\'https://cdn.example/og.png\' property=\'og:image\'>'), 'https://example.com/p')).toBe('https://cdn.example/og.png');
    expect(extractImage(page('<meta name="twitter:image" content="/card.png">'), 'https://example.com/p')).toBe('https://example.com/card.png');
    expect(extractImage(page('<title>none</title>'), 'https://example.com/p')).toBeNull();
  });

  it('takes https addresses only', () => {
    expect(extractImage(page('<meta property="og:image" content="http://cdn.example/a.jpg">'), 'https://example.com/')).toBeNull();
    expect(extractImage(page('<meta property="og:image" content="data:image/png;base64,AAAA">'), 'https://example.com/')).toBeNull();
    expect(extractImage(page('<meta property="og:image" content="javascript:alert(1)">'), 'https://example.com/')).toBeNull();
    expect(extractImage(page(`<meta property="og:image" content="https://cdn.example/${'a'.repeat(2100)}">`), 'https://example.com/')).toBeNull();
  });

  it('stays with the page in the sources of a conversation, also when a search found the page first', () => {
    const searched: ContentBlock = { type: 'tool_result', toolUseId: 's', isError: false, content: [], display: { kind: 'web-search', query: 'q', results: [{ title: 'Found', url: 'https://example.com/p' }] } };
    const fetched: ContentBlock = { type: 'tool_result', toolUseId: 'f', isError: false, content: [], display: { kind: 'fetch', url: 'https://example.com/p', status: 200, bytes: 9, title: 'Read', image: 'https://cdn.example/a.jpg' } };
    expect(sourcesOf([{ content: [searched, fetched] }])).toEqual([{ url: 'https://example.com/p', title: 'Read', state: 'read', image: 'https://cdn.example/a.jpg' }]);
    expect(sourcesOf([{ content: [searched] }])[0]?.image).toBeUndefined();
  });
});
