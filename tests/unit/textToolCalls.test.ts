import { describe, expect, it } from 'vitest';
import {
  extractTextToolCalls,
  textToolPrompt,
  toolCallMarkup,
  ToolMarkupFilter,
  toolResponseMarkup,
} from '../../src/main/providers/textToolCalls';

const tools = new Set(['Read', 'Edit', 'Grep']);

describe('extractTextToolCalls', () => {
  it('reads the Hermes JSON form and keeps the prose around it', () => {
    const input = 'Reading.\n<tool_call>\n{"name":"Read","arguments":{"path":"a.ts"}}\n</tool_call>';
    expect(extractTextToolCalls(input, tools)).toEqual({
      text: 'Reading.',
      calls: [{ name: 'Read', input: { path: 'a.ts' } }],
    });
  });

  it('parses arguments that arrive as a JSON string, and accepts parameters for arguments', () => {
    const asString = '<tool_call>{"name":"Read","arguments":"{\\"path\\":\\"a.ts\\"}"}</tool_call>';
    expect(extractTextToolCalls(asString, tools).calls).toEqual([{ name: 'Read', input: { path: 'a.ts' } }]);
    const asParameters = '<tool_call>{"name":"Read","parameters":{"path":"b.ts"}}</tool_call>';
    expect(extractTextToolCalls(asParameters, tools).calls).toEqual([{ name: 'Read', input: { path: 'b.ts' } }]);
  });

  it('reads the Qwen XML form, with JSON values parsed', () => {
    const input =
      '<function=Edit><parameter=path>a.ts</parameter><parameter=old>x</parameter><parameter=new>y</parameter></function>';
    expect(extractTextToolCalls(input, tools)).toEqual({
      text: '',
      calls: [{ name: 'Edit', input: { path: 'a.ts', old: 'x', new: 'y' } }],
    });
    const numeric = '<function=Read><parameter=path>a.ts</parameter><parameter=limit>20</parameter></function>';
    expect(extractTextToolCalls(numeric, tools).calls).toEqual([{ name: 'Read', input: { path: 'a.ts', limit: 20 } }]);
  });

  it('reads the Qwen XML form inside <tool_call>, trimming one newline from each end of a value', () => {
    const input =
      'Let me look.\n<tool_call>\n<function=Read>\n<parameter=path>\nsrc/a.ts\n</parameter>\n</function>\n</tool_call>';
    expect(extractTextToolCalls(input, tools)).toEqual({
      text: 'Let me look.',
      calls: [{ name: 'Read', input: { path: 'src/a.ts' } }],
    });
  });

  it('reads the Mistral form with two calls, in order', () => {
    const input =
      '[TOOL_CALLS][{"name":"Read","arguments":{"path":"a.ts"}},{"name":"Grep","arguments":{"pattern":"x"}}]';
    expect(extractTextToolCalls(input, tools)).toEqual({
      text: '',
      calls: [
        { name: 'Read', input: { path: 'a.ts' } },
        { name: 'Grep', input: { pattern: 'x' } },
      ],
    });
  });

  it('reads a reply that is only a JSON call when the tool is known, and leaves it alone otherwise', () => {
    const known = '{"name":"Read","arguments":{"path":"a.ts"}}';
    expect(extractTextToolCalls(known, tools)).toEqual({ text: '', calls: [{ name: 'Read', input: { path: 'a.ts' } }] });
    const fenced = '```json\n{"name":"Read","arguments":{"path":"a.ts"}}\n```';
    expect(extractTextToolCalls(fenced, tools)).toEqual({ text: '', calls: [{ name: 'Read', input: { path: 'a.ts' } }] });
    const unknown = '{"name":"Deploy","arguments":{"path":"a.ts"}}';
    expect(extractTextToolCalls(unknown, tools)).toEqual({ text: unknown, calls: [] });
  });

  it('leaves a call inside a code fence alone', () => {
    const input = 'Like this:\n```\n<tool_call>\n{"name":"Read","arguments":{"path":"a.ts"}}\n</tool_call>\n```\nDone.';
    expect(extractTextToolCalls(input, tools)).toEqual({ text: input, calls: [] });
  });

  it('treats an unclosed fence as running to the end of the text', () => {
    const input = 'Like this:\n```xml\n<tool_call>{"name":"Read","arguments":{"path":"a.ts"}}</tool_call>';
    expect(extractTextToolCalls(input, tools)).toEqual({ text: input, calls: [] });
  });

  it('reads a call after a closed fence', () => {
    const input = '```\ncode\n```\n<tool_call>{"name":"Read","arguments":{"path":"a.ts"}}</tool_call>';
    expect(extractTextToolCalls(input, tools)).toEqual({
      text: '```\ncode\n```',
      calls: [{ name: 'Read', input: { path: 'a.ts' } }],
    });
  });

  it('does not read a sentence that mentions the tag as a call', () => {
    const input = 'To call a tool, use <tool_call> tags around the JSON.';
    expect(extractTextToolCalls(input, tools)).toEqual({ text: input, calls: [] });
  });

  it('reads the real call after a sentence that mentions the tag', () => {
    const input = 'I use <tool_call> tags.\n<tool_call>{"name":"Read","arguments":{"path":"a.ts"}}</tool_call>';
    expect(extractTextToolCalls(input, tools)).toEqual({
      text: 'I use <tool_call> tags.',
      calls: [{ name: 'Read', input: { path: 'a.ts' } }],
    });
  });

  it('leaves malformed JSON inside <tool_call> in the text', () => {
    const input = 'Trying.\n<tool_call>{"name":"Read","arguments":{"path":</tool_call>';
    expect(extractTextToolCalls(input, tools)).toEqual({ text: input, calls: [] });
  });

  it('leaves a call to an unknown tool in the text', () => {
    const input = '<tool_call>{"name":"Deploy","arguments":{}}</tool_call>';
    expect(extractTextToolCalls(input, tools)).toEqual({ text: input, calls: [] });
    const xml = '<function=Deploy><parameter=x>1</parameter></function>';
    expect(extractTextToolCalls(xml, tools)).toEqual({ text: xml, calls: [] });
  });

  it('reads back the markup toolCallMarkup writes', () => {
    expect(extractTextToolCalls(toolCallMarkup('Read', { path: 'a' }), new Set(['Read']))).toEqual({
      text: '',
      calls: [{ name: 'Read', input: { path: 'a' } }],
    });
  });
});

describe('ToolMarkupFilter', () => {
  it('holds back a tag that is split across chunks', () => {
    const filter = new ToolMarkupFilter();
    expect(filter.push('Hi <tool_')).toBe('Hi ');
    expect(filter.push('call>{"name":"Read","arguments":{}}</tool_call>')).toBe('');
  });

  it('releases a held prefix once the next chunk shows it is not a tag', () => {
    const filter = new ToolMarkupFilter();
    expect(filter.push('a <tool')).toBe('a ');
    expect(filter.push(' b')).toBe('<tool b');
  });

  it('returns what it held on flush', () => {
    const filter = new ToolMarkupFilter();
    expect(filter.push('x <tool_call> is a tag')).toBe('x ');
    expect(filter.flush()).toBe('<tool_call> is a tag');
  });

  it('holds back the Qwen and Mistral markers too', () => {
    const qwen = new ToolMarkupFilter();
    expect(qwen.push('ok <function=Read>')).toBe('ok ');
    const mistral = new ToolMarkupFilter();
    expect(mistral.push('[TOOL_')).toBe('');
    expect(mistral.push('CALLS][]')).toBe('');
    expect(mistral.flush()).toBe('[TOOL_CALLS][]');
  });
});

describe('textToolPrompt', () => {
  it('teaches the call form and lists each tool', () => {
    const prompt = textToolPrompt([{ name: 'Read', description: 'Reads a file.', inputSchema: { type: 'object' } }]);
    expect(prompt.startsWith('# Calling tools')).toBe(true);
    expect(prompt).toContain('### Read\nReads a file.');
    expect(prompt).toContain('Arguments (JSON Schema): {"type":"object"}');
  });
});

describe('toolResponseMarkup', () => {
  it('wraps a result, marking an error', () => {
    expect(toolResponseMarkup('Read', 'contents', false)).toBe('<tool_response name="Read">\ncontents\n</tool_response>');
    expect(toolResponseMarkup('Read', 'no such file', true)).toBe(
      '<tool_response name="Read">\nError: no such file\n</tool_response>',
    );
  });
});
