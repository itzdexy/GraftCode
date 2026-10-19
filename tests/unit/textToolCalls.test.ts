import { describe, expect, it } from 'vitest';
import {
  extractTextToolCalls,
  textToolPrompt,
  toolCallMarkup,
  ToolMarkupFilter,
  toolResponseMarkup,
} from '../../src/main/providers/textToolCalls';
import { ReadInput } from '../../src/main/tools/fs/read';

const tools = new Map<string, Record<string, unknown>>([
  ['Read', { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'integer' } } }],
  ['Edit', { type: 'object', properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } } }],
  ['Grep', { type: 'object', properties: { pattern: { type: 'string' } } }],
  ['Write', { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, mode: { type: ['string', 'null'] } } }],
]);

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

  it('keeps an XML value the schema calls a string as the text the model wrote', () => {
    const json = '<function=Write><parameter=path>a.json</parameter><parameter=content>{"name":"x"}</parameter></function>';
    expect(extractTextToolCalls(json, tools).calls).toEqual([
      { name: 'Write', input: { path: 'a.json', content: '{"name":"x"}' } },
    ]);
    const number =
      '<function=Write><parameter=path>n.txt</parameter><parameter=content>\n42\n</parameter><parameter=mode>true</parameter></function>';
    expect(extractTextToolCalls(number, tools).calls).toEqual([
      { name: 'Write', input: { path: 'n.txt', content: '42', mode: 'true' } },
    ]);
  });

  it('still reads an XML value as JSON when the schema gives another type', () => {
    const input = '<function=Read><parameter=path>a.ts</parameter><parameter=limit>20</parameter></function>';
    expect(extractTextToolCalls(input, tools).calls).toEqual([{ name: 'Read', input: { path: 'a.ts', limit: 20 } }]);
  });

  it('reads an XML value as JSON when the schema has no entry for it', () => {
    const input = '<function=Grep><parameter=pattern>x</parameter><parameter=count>7</parameter></function>';
    expect(extractTextToolCalls(input, tools).calls).toEqual([{ name: 'Grep', input: { pattern: 'x', count: 7 } }]);
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

  it('leaves a call quoted in inline code alone', () => {
    const single = 'The format is `<tool_call>{"name":"Read","arguments":{"path":"a.ts"}}</tool_call>`.';
    expect(extractTextToolCalls(single, tools)).toEqual({ text: single, calls: [] });
    const double = 'Write ``<tool_call>{"name":"Read","arguments":{"path":"a.ts"}}</tool_call>`` to call one.';
    expect(extractTextToolCalls(double, tools)).toEqual({ text: double, calls: [] });
    const xml = 'Or `<function=Read><parameter=path>a.ts</parameter></function>` in XML.';
    expect(extractTextToolCalls(xml, tools)).toEqual({ text: xml, calls: [] });
  });

  it('reads the real call on the line after an inline-code mention', () => {
    const mention = 'The format is `<tool_call>{"name":"Read","arguments":{"path":"x"}}</tool_call>`.';
    const input = `${mention}\n<tool_call>{"name":"Read","arguments":{"path":"a.ts"}}</tool_call>`;
    expect(extractTextToolCalls(input, tools)).toEqual({ text: mention, calls: [{ name: 'Read', input: { path: 'a.ts' } }] });
  });

  it('reads a call after a lone backtick that opens no code span', () => {
    const input = 'Note the ` mark. <tool_call>{"name":"Read","arguments":{"path":"a.ts"}}</tool_call>';
    expect(extractTextToolCalls(input, tools)).toEqual({ text: 'Note the ` mark.', calls: [{ name: 'Read', input: { path: 'a.ts' } }] });
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
    expect(extractTextToolCalls(toolCallMarkup('Read', { path: 'a' }), new Map([['Read', {}]]))).toEqual({
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

  it("teaches with an example call the Read tool's own schema accepts", () => {
    const prompt = textToolPrompt([]);
    const example = /<tool_call>\n(.*)\n<\/tool_call>/.exec(prompt)?.[1] ?? '';
    const call = JSON.parse(example) as { name: string; arguments: unknown };
    expect(call.name).toBe('Read');
    expect(ReadInput.safeParse(call.arguments).success).toBe(true);
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
