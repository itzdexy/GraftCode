import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAiChatProvider } from '../../src/main/providers/openaiChat';
import { toResponsesInput, usesResponses } from '../../src/main/providers/openaiResponses';
import type { StreamEvent, StreamRequest } from '../../src/main/providers/types';
import type { LlmMessage } from '../../src/shared/schemas/messages';
import { fakeModel } from '../support/fakeProvider';
import { json, sse, startFixtureServer, type FixtureServer } from '../support/httpFixture';

async function collect(iterable: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of iterable) out.push(e);
  return out;
}

const PRO = fakeModel({
  ref: { providerId: 'o', modelId: 'gpt-5.5-pro' },
  effort: { levels: ['medium', 'high', 'taproot'], recommended: 'high', default: 'high', values: { medium: 'medium', high: 'high', taproot: 'xhigh' } }
});

function request(overrides: Partial<StreamRequest> = {}): StreamRequest {
  return {
    model: PRO,
    system: 'You are a test.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'Read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
    effort: 'high',
    webSearch: false,
    cacheKey: 'session-1',
    privacy: { noTraining: false, zeroRetention: false },
    ...overrides
  };
}

const REASONING = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Checking the file.' }], encrypted_content: 'ENC' };
const MESSAGE = { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Let me look.' }] };
const CALL = { type: 'function_call', id: 'fc_1', call_id: 'call_7', name: 'Read', arguments: '{"path":"a.ts"}' };

/** What the Responses API streams for one reply that thinks, says something and calls a tool. */
const REPLY = [
  { event: 'response.created', data: { type: 'response.created', response: { status: 'in_progress' } } },
  { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } } },
  { event: 'response.reasoning_summary_text.delta', data: { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'Checking ' } },
  { event: 'response.reasoning_summary_text.delta', data: { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'the file.' } },
  { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: 0, item: REASONING } },
  { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 1, item: { ...MESSAGE, content: [] } } },
  { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', output_index: 1, delta: 'Let me ' } },
  { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', output_index: 1, delta: 'look.' } },
  { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: 1, item: MESSAGE } },
  { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 2, item: { ...CALL, arguments: '' } } },
  { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"path":' } },
  { event: 'response.function_call_arguments.done', data: { type: 'response.function_call_arguments.done', output_index: 2, arguments: '{"path":"a.ts"}' } },
  { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: 2, item: CALL } },
  {
    event: 'response.completed',
    data: {
      type: 'response.completed',
      response: {
        status: 'completed',
        output: [REASONING, MESSAGE, CALL],
        usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 100 }, output_tokens_details: { reasoning_tokens: 12 } }
      }
    }
  }
];

describe('OpenAI Responses API', () => {
  let server: FixtureServer;
  beforeEach(async () => {
    server = await startFixtureServer();
  });
  afterEach(async () => {
    await server.close();
  });
  const openai = (): OpenAiChatProvider => new OpenAiChatProvider({ id: 'o', kind: 'openai', preset: null, apiKey: 'sk-test', baseUrl: `${server.url}/v1` });

  it('knows which OpenAI models answer only there', () => {
    for (const id of ['gpt-5.5-pro', 'gpt-5-pro', 'o3-pro', 'gpt-5-codex', 'gpt-5.3-codex-spark', 'codex-mini-latest', 'o3-deep-research']) expect(usesResponses(id), id).toBe(true);
    for (const id of ['gpt-5.5', 'gpt-5-mini', 'gpt-4.1', 'o3', 'gpt-4o', 'gpt-5.3-chat-latest']) expect(usesResponses(id), id).toBe(false);
  });

  it('streams the summary of its reasoning, text and a tool call, and keeps the reasoning to send back', async () => {
    server.route('POST', '/v1/responses', (_req, res) => sse(res, REPLY));
    const events = await collect(openai().streamText(request(), new AbortController().signal));
    expect(server.requests.map((r) => r.path)).toEqual(['/v1/responses']);
    expect(events.filter((e) => e.type === 'thinking-delta')).toEqual([
      { type: 'thinking-delta', text: 'Checking ' },
      { type: 'thinking-delta', text: 'the file.' }
    ]);
    expect(events.filter((e) => e.type === 'text-delta').map((e) => (e.type === 'text-delta' ? e.text : ''))).toEqual(['Let me ', 'look.']);
    expect(events.filter((e) => e.type === 'block')).toEqual([
      { type: 'block', block: { type: 'thinking', text: 'Checking the file.', display: 'summary', origin: 'openai' } },
      { type: 'block', block: { type: 'provider', provider: 'openai', raw: { model: 'gpt-5.5-pro', output: [REASONING, MESSAGE, CALL] }, summary: '' } },
      { type: 'block', block: { type: 'text', text: 'Let me look.' } },
      { type: 'block', block: { type: 'tool_use', id: 'call_7', name: 'Read', input: { path: 'a.ts' } } }
    ]);
    // Cached input is counted apart from the rest, as the other adapters do.
    expect(events.find((e) => e.type === 'usage')).toEqual({ type: 'usage', usage: { inputTokens: 20, outputTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 0 } });
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool_use' });
  });

  it('sends the instructions, tools, effort and cache key in the Responses shape, without keeping the conversation on OpenAI', async () => {
    server.route('POST', '/v1/responses', (_req, res) => sse(res, REPLY));
    await collect(openai().streamText(request(), new AbortController().signal));
    const sent = server.requests[0]!;
    expect(sent.headers.authorization).toBe('Bearer sk-test');
    expect(sent.json()).toEqual({
      model: 'gpt-5.5-pro',
      stream: true,
      store: false,
      instructions: 'You are a test.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      // Strict mode would reject the loose schemas that MCP tools bring.
      tools: [{ type: 'function', name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } }, strict: false }],
      max_output_tokens: 8000,
      reasoning: { effort: 'high', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: 'session-1'
    });
  });

  it('uses the model’s own wire value for the strongest effort', async () => {
    server.route('POST', '/v1/responses', (_req, res) => sse(res, REPLY));
    await collect(openai().streamText(request({ effort: 'taproot' }), new AbortController().signal));
    expect(server.requests[0]!.json()).toMatchObject({ reasoning: { effort: 'xhigh', summary: 'auto' } });
  });

  it('sends the reasoning back with the tool result on the next request, exactly as it was received', () => {
    const history: LlmMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'Checking the file.', display: 'summary', origin: 'openai' },
          { type: 'provider', provider: 'openai', raw: { model: 'gpt-5.5-pro', output: [REASONING, MESSAGE, CALL] }, summary: '' },
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_use', id: 'call_7', name: 'Read', input: { path: 'a.ts' } }
        ]
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_7', content: [{ type: 'text', text: 'export const a = 1;' }], isError: false }] }
    ];
    expect(toResponsesInput(history, true, 'gpt-5.5-pro')).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      REASONING,
      MESSAGE,
      CALL,
      { type: 'function_call_output', call_id: 'call_7', output: 'export const a = 1;' }
    ]);
    // After a switch to another model the old reasoning is not sent; the reply is rebuilt from what was said and called.
    expect(toResponsesInput(history, true, 'gpt-5.4-pro')).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { role: 'assistant', content: 'Let me look.' },
      { type: 'function_call', call_id: 'call_7', name: 'Read', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'call_7', output: 'export const a = 1;' }
    ]);
  });

  it('marks a failed tool result, keeps pictures for models that can see them, and says when they cannot', () => {
    const history: LlmMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'Browser', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'call_1', isError: true, content: [{ type: 'text', text: 'No page is open.' }] },
          { type: 'text', text: 'try again' }
        ]
      }
    ];
    const seeing = toResponsesInput(history, true, 'gpt-5.5-pro');
    expect(seeing[0]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] });
    expect(seeing[2]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: 'Error: No page is open.' });
    expect(seeing[3]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'try again' }] });
    expect(JSON.stringify(toResponsesInput(history, false, 'gpt-5.5-pro')[0])).toContain('cannot view images');
  });

  it('goes to the Responses API when chat completions says the model is only there, and remembers it', async () => {
    server.route('POST', '/v1/chat/completions', (_req, res) =>
      json(res, 404, { error: { message: 'This model is only supported in v1/responses and not in v1/chat/completions.', type: 'invalid_request_error' } })
    );
    server.route('POST', '/v1/responses', (_req, res) => sse(res, REPLY));
    const provider = openai();
    const model = fakeModel({ ref: { providerId: 'o', modelId: 'gpt-5.9-turbo' }, effort: null });
    const first = await collect(provider.streamText(request({ model, effort: null }), new AbortController().signal));
    expect(first.at(-1)).toEqual({ type: 'finish', reason: 'tool_use' });
    expect(server.requests.map((r) => r.path)).toEqual(['/v1/chat/completions', '/v1/responses']);
    await collect(provider.streamText(request({ model, effort: null }), new AbortController().signal));
    // The second request goes straight there.
    expect(server.requests.map((r) => r.path)).toEqual(['/v1/chat/completions', '/v1/responses', '/v1/responses']);
  });

  it('asks again without the reasoning summary when the account is not allowed one', async () => {
    let calls = 0;
    server.route('POST', '/v1/responses', async (req, res) => {
      calls++;
      const body = req.json() as { reasoning?: { summary?: string } };
      if (body.reasoning?.summary) return json(res, 400, { error: { message: 'Your organization must be verified to generate reasoning summaries.' } });
      await sse(res, REPLY);
    });
    const events = await collect(openai().streamText(request(), new AbortController().signal));
    expect(calls).toBe(2);
    expect(server.requests[1]!.json()).toMatchObject({ reasoning: { effort: 'high' } });
    expect(JSON.stringify(server.requests[1]!.json())).not.toContain('summary":"auto');
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool_use' });
  });

  it('reports a reply cut off by its limit, and failures the stream announces', async () => {
    let stream: Array<{ event?: string; data: unknown }> = [
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', output_index: 0, delta: 'Partial' } },
      { event: 'response.incomplete', data: { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 10, output_tokens: 8000 } } } }
    ];
    server.route('POST', '/v1/responses', (_req, res) => sse(res, stream));
    const cut = await collect(openai().streamText(request(), new AbortController().signal));
    expect(cut.filter((e) => e.type === 'block')).toEqual([{ type: 'block', block: { type: 'text', text: 'Partial' } }]);
    expect(cut.at(-1)).toEqual({ type: 'finish', reason: 'max_tokens' });

    const failed = (code: string, message: string) => [{ event: 'response.failed', data: { type: 'response.failed', response: { status: 'failed', error: { code, message } } } }];
    stream = failed('context_length_exceeded', 'Your input exceeds the context window of this model.');
    await expect(collect(openai().streamText(request(), new AbortController().signal))).rejects.toMatchObject({ code: 'context_length' });
    stream = failed('rate_limit_exceeded', 'Slow down.');
    await expect(collect(openai().streamText(request(), new AbortController().signal))).rejects.toMatchObject({ code: 'rate_limit', retryable: true });
    // A stream that stops without saying it is done was cut off, and the reply is not taken as complete.
    stream = [{ event: 'response.output_text.delta', data: { type: 'response.output_text.delta', output_index: 0, delta: 'Half a sen' } }];
    await expect(collect(openai().streamText(request(), new AbortController().signal))).rejects.toMatchObject({ code: 'network' });
  });

  it('lists the Codex models, which only this API serves, and still leaves out what chat cannot use', async () => {
    server.route('GET', '/v1/models', (_req, res) =>
      json(res, 200, { data: [{ id: 'gpt-5-codex', created: 1 }, { id: 'gpt-5.5-pro', created: 2 }, { id: 'gpt-5.5', created: 3 }, { id: 'text-embedding-3-small', created: 4 }, { id: 'gpt-image-1', created: 5 }] })
    );
    const models = await openai().listModels();
    expect(models.map((m) => m.ref.modelId).sort()).toEqual(['gpt-5-codex', 'gpt-5.5', 'gpt-5.5-pro']);
  });
});
