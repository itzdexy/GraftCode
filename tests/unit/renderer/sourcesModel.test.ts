import { describe, expect, it } from 'vitest';
import { citationNote, citationState, sourcesHeading, turnSources } from '../../../src/renderer/src/features/session/sourcesModel';
import { buildTranscript, groupActivity, type ToolCall } from '../../../src/renderer/src/features/session/transcriptModel';
import type { StoredMessage } from '../../../src/shared/schemas/messages';
import { sourceIndex } from '../../../src/shared/sources';

const fetchCall = (url: string, status: number, title: string | null): ToolCall => ({
  id: url,
  name: 'WebFetch',
  input: { url },
  running: null,
  result: { type: 'tool_result', toolUseId: url, isError: status >= 400, content: [], display: { kind: 'fetch', url, status, bytes: 1, title } }
});

describe('sources in the transcript', () => {
  it('says how a cited page was seen', () => {
    expect(citationNote('read')).toBe('Opened in this conversation');
    expect(citationNote('found')).toBe('Found by a search, not opened');
    expect(citationNote('unseen')).toBe('Not opened or found in this conversation');
  });

  it('marks nothing in a conversation without sources', () => {
    expect(citationState('https://example.com/a', null)).toBeNull();
    const index = sourceIndex([{ url: 'https://example.com/a', title: null, state: 'read' }]);
    expect(citationState('http://www.example.com/a/', index)).toBe('read');
    expect(citationState('https://example.com/other', index)).toBe('unseen');
  });

  it('lists the pages a turn read, once each, without the ones that failed', () => {
    const calls = [
      fetchCall('https://example.com/a', 200, 'Page A'),
      fetchCall('https://example.com/a#x', 200, 'Page A'),
      fetchCall('https://example.com/gone', 404, null),
      { ...fetchCall('https://example.com/later', 200, null), result: null }
    ];
    expect(turnSources(calls)).toEqual([{ url: 'https://example.com/a', title: 'Page A', state: 'read' }]);
    expect([sourcesHeading(1), sourcesHeading(3)]).toEqual(['Read 1 page', 'Read 3 pages']);
  });

  it('ends a finished turn that read pages with their list, after the files it made, and adds nothing to a turn that read none', () => {
    let seq = 0;
    const message = (role: StoredMessage['role'], content: StoredMessage['content']): StoredMessage => ({
      id: `m${String(++seq)}`,
      sessionId: 's',
      seq,
      role,
      content,
      createdAt: seq,
      meta: {}
    });
    const use = (id: string, name: string, input: object): StoredMessage['content'][number] => ({ type: 'tool_use', id, name, input });
    const messages = [
      message('user', [{ type: 'text', text: 'Look it up' }]),
      message('assistant', [use('f1', 'WebFetch', { url: 'https://example.com/a' }), use('c1', 'CreateFile', { name: 'notes.md', content: '# N' })]),
      message('user', [
        { type: 'tool_result', toolUseId: 'f1', isError: false, content: [], display: { kind: 'fetch', url: 'https://example.com/a', status: 200, bytes: 9, title: 'Page A' } },
        { type: 'tool_result', toolUseId: 'c1', isError: false, content: [], display: { kind: 'file', name: 'notes.md', size: 3, mime: 'text/markdown', preview: '# N' } }
      ]),
      message('assistant', [{ type: 'text', text: 'Here it is.' }]),
      message('user', [{ type: 'text', text: 'Thanks' }]),
      message('assistant', [{ type: 'text', text: 'Any time.' }])
    ];
    const items = groupActivity(buildTranscript(messages, { streaming: null, running: {} }), false);
    const kinds = items.map((item) => item.kind);
    expect(kinds.filter((kind) => kind === 'sources')).toHaveLength(1);
    expect(kinds.indexOf('sources')).toBe(kinds.indexOf('files') + 1);
    expect(items.find((item) => item.kind === 'sources')).toMatchObject({ sources: [{ url: 'https://example.com/a', title: 'Page A', state: 'read' }] });
    // While the turn is still running there is no list yet: it comes with the finished answer.
    const running = groupActivity(buildTranscript(messages.slice(0, 3), { streaming: null, running: {} }), true);
    expect(running.some((item) => item.kind === 'sources')).toBe(false);
  });
});
