import { describe, expect, it } from 'vitest';
import { contextBreakdown, contextLines } from '../../src/main/agent/contextBreakdown';

describe('what fills the context', () => {
  it('splits what would be sent into parts, largest first, without the empty ones', () => {
    const parts = contextBreakdown({
      system: 's'.repeat(3500),
      tools: [
        { name: 'Read', description: 'd'.repeat(2090), inputSchema: {} },
        { name: 'mcp__gh__create_issue', description: 'd'.repeat(1390), inputSchema: {} }
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'u'.repeat(350) }] },
        { role: 'assistant', content: [{ type: 'thinking', text: 't'.repeat(700), display: 'summary' }, { type: 'text', text: 'a'.repeat(1050) }, { type: 'tool_use', id: 'x', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'x', isError: false, content: [{ type: 'text', text: 'r'.repeat(7000) }, { type: 'image', mediaType: 'image/png', data: 'AA' }] }] }
      ]
    });
    expect(parts.map((p) => [p.id, p.label])).toEqual([
      ['results', 'Tool results'],
      ['system', 'System prompt'],
      ['tools', 'Built-in tools'],
      ['mcp', 'MCP tools'],
      ['replies', 'Replies'],
      ['reasoning', 'Reasoning'],
      ['user', 'Your messages']
    ]);
    const tokens = Object.fromEntries(parts.map((p) => [p.id, p.tokens]));
    expect(tokens).toMatchObject({ results: 3600, system: 1000, replies: 311, reasoning: 200, user: 100 });
    expect(tokens.tools).toBeGreaterThan(600);
    expect(tokens.mcp).toBeGreaterThan(400);
    expect(contextBreakdown({ system: 's'.repeat(35), tools: [], messages: [] })).toEqual([{ id: 'system', label: 'System prompt', tokens: 10 }]);
    expect(contextBreakdown({ system: '', tools: [], messages: [] })).toEqual([]);
  });

  it('counts a picture the user sent as theirs, and whole numbers only', () => {
    const parts = contextBreakdown({
      system: '',
      tools: [],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', mediaType: 'image/png', data: 'AA' }] },
        { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'x'.repeat(33) }] }
      ]
    });
    expect(parts).toEqual([
      { id: 'user', label: 'Your messages', tokens: 1602 },
      { id: 'reasoning', label: 'Reasoning', tokens: 5 }
    ]);
  });

  it('writes the lines /context prints', () => {
    const parts = [
      { id: 'results' as const, label: 'Tool results', tokens: 22_100 },
      { id: 'system' as const, label: 'System prompt', tokens: 6_300 }
    ];
    expect(contextLines({ parts, measured: 43_812, limit: 200_000 })).toEqual([
      'Context: about 28,400 of 200,000 tokens (14%).',
      '- Tool results: 22,100',
      '- System prompt: 6,300',
      'Estimated from the text; the provider counted 43,812.'
    ]);
    expect(contextLines({ parts, measured: null, limit: 0 })).toEqual(['Context: about 28,400 tokens (window size unknown).', '- Tool results: 22,100', '- System prompt: 6,300', 'Estimated from the text.']);
    // Nothing to send yet, and a window smaller than the estimate: still whole, honest numbers.
    expect(contextLines({ parts: [], measured: null, limit: 100_000 })).toEqual(['Context: about 0 of 100,000 tokens (0%).', 'Estimated from the text.']);
    expect(contextLines({ parts, measured: null, limit: 20_000 })[0]).toBe('Context: about 28,400 of 20,000 tokens (142%).');
  });
});
