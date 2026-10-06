import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseNdjson, parseSse } from '../../src/main/providers/sse';
import { errorFromHttp, parseRetryAfter, ProviderError } from '../../src/main/providers/errors';
import { backoffDelay, DEFAULT_RETRY_POLICY, streamWithRetry } from '../../src/main/providers/retry';
import { AnthropicProvider, toAnthropicMessages } from '../../src/main/providers/anthropic';
import { OpenAiChatProvider, toChatMessages } from '../../src/main/providers/openaiChat';
import { GeminiProvider, toGeminiContents } from '../../src/main/providers/gemini';
import { OllamaProvider } from '../../src/main/providers/ollama';
import { arrangeModels, familyOf, formatTokens } from '../../src/main/providers/catalog';
import type { StreamEvent, StreamRequest } from '../../src/main/providers/types';
import type { LlmMessage } from '../../src/shared/schemas/messages';
import { FakeProvider, fakeModel } from '../support/fakeProvider';
import { json, ndjson, sse, startFixtureServer, type FixtureServer } from '../support/httpFixture';

function streamOf(text: string, split = 3): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(i, i + split));
      i += split;
    }
  });
}

async function collect(iterable: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of iterable) out.push(e);
  return out;
}

function request(overrides: Partial<StreamRequest> = {}): StreamRequest {
  return {
    model: fakeModel(),
    system: 'You are a test.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'Read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
    effort: 'medium',
    webSearch: false,
    cacheKey: 'session-1',
    privacy: { noTraining: false, zeroRetention: false },
    ...overrides
  };
}

describe('SSE and NDJSON parsing', () => {
  it('handles CRLF split across chunks, multi-line data, comments and a trailing event', async () => {
    const body = ': ping\r\nevent: a\r\ndata: one\r\ndata: two\r\n\r\ndata: {"x":1}\n\ndata: last';
    const events = [];
    for await (const e of parseSse(streamOf(body, 1))) events.push(e);
    expect(events).toEqual([
      { event: 'a', data: 'one\ntwo' },
      { event: null, data: '{"x":1}' },
      { event: null, data: 'last' }
    ]);
  });

  it('parses NDJSON with blank lines and rejects malformed lines with context', async () => {
    const out = [];
    for await (const v of parseNdjson(streamOf('{"a":1}\n\n{"b":2}\n', 4))) out.push(v);
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
    await expect(async () => {
      for await (const v of parseNdjson(streamOf('{"a":\n'))) void v;
    }).rejects.toThrow(/Malformed streaming JSON/);
  });
});

describe('error normalization and retry', () => {
  const headers = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null });

  it('maps status codes to specific error codes', () => {
    expect(errorFromHttp(401, '{"error":{"message":"invalid x-api-key"}}', undefined, 'api.test').code).toBe('auth');
    expect(errorFromHttp(403, '', undefined, 'api.test').code).toBe('auth');
    expect(errorFromHttp(404, '', undefined, 'api.test').code).toBe('not_found');
    const limited = errorFromHttp(429, '', headers({ 'retry-after': '3' }), 'api.test');
    expect(limited).toMatchObject({ code: 'rate_limit', retryable: true, retryAfterMs: 3000 });
    expect(errorFromHttp(529, '', undefined, 'api.test')).toMatchObject({ code: 'overloaded', retryable: true });
    expect(errorFromHttp(500, '', undefined, 'api.test')).toMatchObject({ code: 'server', retryable: true });
    expect(errorFromHttp(400, '{"error":{"message":"prompt is too long: 250000 tokens"}}', undefined, 'x').code).toBe('context_length');
    expect(errorFromHttp(400, '{"error":{"message":"bad field"}}', undefined, 'x')).toMatchObject({ code: 'bad_request', retryable: false });
    expect(errorFromHttp(200 + 204, '<!doctype html><html></html>', undefined, 'example.com').code).toBe('bad_base_url');
    expect(parseRetryAfter(headers({ 'retry-after-ms': '1500' }))).toBe(1500);
  });

  it('uses exponential backoff with jitter bounds and honors retry-after', () => {
    const e = new ProviderError('server', 'x');
    expect(backoffDelay(1, e, DEFAULT_RETRY_POLICY, () => 0.5)).toBe(1000);
    expect(backoffDelay(3, e, DEFAULT_RETRY_POLICY, () => 0.5)).toBe(4000);
    expect(backoffDelay(10, e, DEFAULT_RETRY_POLICY, () => 1)).toBe(36_000);
    expect(backoffDelay(1, new ProviderError('rate_limit', 'x', { retryAfterMs: 120_000 }), DEFAULT_RETRY_POLICY)).toBe(60_000);
  });

  const fast = { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 5, maxRetryAfterMs: 5 };

  it('retries overloaded/5xx before the first event, then succeeds', async () => {
    const provider = new FakeProvider([
      { error: new ProviderError('overloaded', 'busy') },
      { error: new ProviderError('server', 'oops') },
      { text: 'done' }
    ]);
    const retries: number[] = [];
    const events = await collect(streamWithRetry(provider, request(), new AbortController().signal, (i) => retries.push(i.attempt), fast));
    expect(retries).toEqual([1, 2]);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('does not retry after output was streamed, nor on auth errors', async () => {
    const midStream = new FakeProvider([{ error: new ProviderError('server', 'dropped'), partialText: 'Hel' }, { text: 'never' }]);
    await expect(collect(streamWithRetry(midStream, request(), new AbortController().signal, () => undefined, fast))).rejects.toMatchObject({
      code: 'server'
    });
    expect(midStream.remaining).toBe(1);
    const auth = new FakeProvider([{ error: new ProviderError('auth', 'bad key') }, { text: 'never' }]);
    await expect(collect(streamWithRetry(auth, request(), new AbortController().signal, () => undefined, fast))).rejects.toMatchObject({
      code: 'auth'
    });
  });

  it('stops waiting when aborted during backoff', async () => {
    const provider = new FakeProvider([{ error: new ProviderError('rate_limit', 'slow down', { retryAfterMs: 10_000 }) }, { text: 'x' }]);
    const controller = new AbortController();
    const policy = { ...fast, maxRetryAfterMs: 10_000 };
    const run = collect(streamWithRetry(provider, request(), controller.signal, () => setTimeout(() => controller.abort(), 20), policy));
    await expect(run).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('catalog helpers', () => {
  it('groups model lines without naming them', () => {
    expect(familyOf('vendor-pro-2.5-preview-05-06')).toBe(familyOf('vendor-pro-3'));
    expect(familyOf('vendor-pro-3')).not.toBe(familyOf('vendor-flash-3'));
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(200_000)).toBe('200K');
    expect(formatTokens(131_072)).toBe('128K');
    // A round decimal size is not a binary one: 128,000 is 125 x 1,024 and used to read "125K".
    expect([128_000, 256_000, 512_000, 64_000, 32_768, 262_144, 8_192, 1_048_576].map(formatTokens)).toEqual(['128K', '256K', '512K', '64K', '32K', '256K', '8K', '1M']);
    const arranged = arrangeModels([
      fakeModel({ ref: { providerId: 'p', modelId: 'line-a-1' }, family: 'line-a', createdAt: 1 }),
      fakeModel({ ref: { providerId: 'p', modelId: 'line-a-2' }, family: 'line-a', createdAt: 2 }),
      fakeModel({ ref: { providerId: 'p', modelId: 'line-b-1' }, family: 'line-b', createdAt: 3 })
    ]);
    expect(arranged.map((m) => [m.ref.modelId, m.featured])).toEqual([
      ['line-b-1', true],
      ['line-a-2', true],
      ['line-a-1', false]
    ]);
  });
});

describe('Anthropic adapter', () => {
  let server: FixtureServer;
  beforeEach(async () => {
    server = await startFixtureServer();
  });
  afterEach(async () => {
    await server.close();
  });

  const modelJson = {
    type: 'model',
    id: 'test-model-9',
    display_name: 'Test Model 9',
    created_at: '2026-08-01T00:00:00Z',
    max_input_tokens: 1_000_000,
    max_tokens: 128_000,
    capabilities: {
      batch: { supported: true },
      citations: { supported: true },
      code_execution: { supported: false },
      context_management: {},
      effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } },
      image_input: { supported: true },
      pdf_input: { supported: true },
      structured_outputs: { supported: true },
      thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } }
    }
  };

  function streamEvents(): Array<{ event: string; data: unknown }> {
    return [
      { event: 'message_start', data: { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'test-model-9', content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Checking the file first.' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Reading ' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'it now.' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"src/a.ts"}' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 42 } } },
      { event: 'message_stop', data: { type: 'message_stop' } }
    ];
  }

  it('lists models with capability-derived effort levels and descriptions', async () => {
    server.route('GET', '/v1/models', (_req, res) => json(res, 200, { data: [modelJson], has_more: false, first_id: 'test-model-9', last_id: 'test-model-9' }));
    const provider = new AnthropicProvider({ id: 'a', kind: 'anthropic', preset: null, apiKey: 'sk-test', baseUrl: server.url });
    const [model] = await provider.listModels();
    expect(model).toMatchObject({
      label: 'Test Model 9',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      supportsVision: true,
      featured: true,
      effort: { levels: ['low', 'medium', 'high', 'extra', 'max', 'taproot'], recommended: 'medium' }
    });
    expect(model?.description).toBe('1M context · deep reasoning · vision');
    expect(server.requests[0]?.headers['x-api-key']).toBe('sk-test');
  });

  it('streams thinking, text and a tool call, and sends effort, caching and progress-update display', async () => {
    server.route('GET', '/v1/models', (_req, res) => json(res, 200, { data: [modelJson], has_more: false }));
    server.route('POST', '/v1/messages', (_req, res) => sse(res, streamEvents()));
    const provider = new AnthropicProvider({ id: 'a', kind: 'anthropic', preset: null, apiKey: 'sk-test', baseUrl: server.url });
    const [model] = await provider.listModels();
    const events = await collect(provider.streamText(request({ model: model!, effort: 'extra' }), new AbortController().signal));
    const blocks = events.filter((e) => e.type === 'block').map((e) => (e.type === 'block' ? e.block : null));
    expect(blocks).toEqual([
      { type: 'thinking', text: 'Checking the file first.', signature: 'sig-abc', display: 'update', origin: 'anthropic' },
      { type: 'text', text: 'Reading it now.' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'src/a.ts' } }
    ]);
    expect(events.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      usage: { inputTokens: 12, outputTokens: 42, cacheReadTokens: 100, cacheWriteTokens: 5 }
    });
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool_use' });

    const sent = server.requests.find((r) => r.path.startsWith('/v1/messages'));
    const body = sent?.json() as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'updates' });
    expect(body.output_config).toEqual({ effort: 'xhigh' });
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
    expect((body.system as Array<Record<string, unknown>>)[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect((body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({ name: 'Read', eager_input_streaming: true });
    expect(body).not.toHaveProperty('temperature');
    expect(String(sent?.headers['anthropic-beta'])).toContain('thinking-display-updates');
  });

  it('falls back to summarized thinking when a model rejects progress-update display', async () => {
    server.route('GET', '/v1/models', (_req, res) => json(res, 200, { data: [modelJson], has_more: false }));
    let calls = 0;
    server.route('POST', '/v1/messages', async (_req, res) => {
      calls++;
      if (calls === 1) return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'thinking.display: "updates" is not supported' } });
      await sse(res, streamEvents());
    });
    const provider = new AnthropicProvider({ id: 'a', kind: 'anthropic', preset: null, apiKey: 'sk-test', baseUrl: server.url });
    const [model] = await provider.listModels();
    const events = await collect(provider.streamText(request({ model: model! }), new AbortController().signal));
    const thinking = events.find((e) => e.type === 'block' && e.block.type === 'thinking');
    expect(thinking).toMatchObject({ block: { display: 'summary' } });
    const bodies = server.requests.filter((r) => r.path.startsWith('/v1/messages')).map((r) => r.json() as { thinking: unknown });
    expect(bodies.map((b) => b.thinking)).toEqual([
      { type: 'adaptive', display: 'updates' },
      { type: 'adaptive', display: 'summarized' }
    ]);
  });

  it('offers server-side web search when enabled and falls back to the older tool version', async () => {
    server.route('GET', '/v1/models', (_req, res) => json(res, 200, { data: [modelJson], has_more: false }));
    let calls = 0;
    server.route('POST', '/v1/messages', async (req, res) => {
      calls++;
      const tools = (req.json() as { tools: Array<{ type?: string }> }).tools;
      if (tools.some((t) => t.type === 'web_search_20260209')) return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'tools.1: web_search_20260209 is not supported for this model' } });
      await sse(res, streamEvents());
    });
    const provider = new AnthropicProvider({ id: 'a', kind: 'anthropic', preset: null, apiKey: 'sk-test', baseUrl: server.url });
    const [model] = await provider.listModels();
    await collect(provider.streamText(request({ model: model!, webSearch: true }), new AbortController().signal));
    const sent = server.requests.filter((r) => r.path.startsWith('/v1/messages')).map((r) => (r.json() as { tools: Array<{ type?: string; name: string }> }).tools.map((t) => t.type ?? t.name));
    expect(calls).toBe(2);
    expect(sent).toEqual([['Read', 'web_search_20260209'], ['Read', 'web_search_20250305']]);
    await collect(provider.streamText(request({ model: model!, webSearch: false }), new AbortController().signal));
    expect((server.requests.at(-1)?.json() as { tools: unknown[] }).tools).toHaveLength(1);
  });

  it('normalizes auth and overload errors', async () => {
    server.route('GET', '/v1/models', (_req, res) => json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    const provider = new AnthropicProvider({ id: 'a', kind: 'anthropic', preset: null, apiKey: 'bad', baseUrl: server.url });
    await expect(provider.listModels()).rejects.toMatchObject({ code: 'auth', retryable: false });
  });

  it('drops unsigned or foreign thinking and keeps provider blocks for replay', () => {
    const history: LlmMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'mine', signature: 's1', origin: 'anthropic' },
          { type: 'thinking', text: 'interrupted', origin: 'anthropic' },
          { type: 'thinking', text: 'other vendor', origin: 'openai' },
          { type: 'provider', provider: 'anthropic', raw: { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'x' } }, summary: '' },
          { type: 'provider', provider: 'gemini', raw: { foo: 1 }, summary: '' },
          { type: 'text', text: '' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a' } }
        ]
      }
    ];
    const [msg] = toAnthropicMessages(history, true);
    expect(msg?.content).toEqual([
      { type: 'thinking', thinking: 'mine', signature: 's1' },
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'x' } },
      { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a' } }
    ]);
  });
});

describe('OpenAI-style chat adapter', () => {
  let server: FixtureServer;
  beforeEach(async () => {
    server = await startFixtureServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it('streams text and a tool call whose arguments arrive in pieces', async () => {
    server.route('POST', '/v1/chat/completions', (_req, res) =>
      sse(res, [
        { data: { choices: [{ index: 0, delta: { role: 'assistant', content: 'Let me ' } }] } },
        { data: { choices: [{ index: 0, delta: { content: 'check.' } }] } },
        { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'Grep', arguments: '{"pat' } }] } }] } },
        { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'tern":"TODO"}' } }] } }] } },
        { data: { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] } },
        { data: { choices: [], usage: { prompt_tokens: 50, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 30 } } } },
        { data: '[DONE]' }
      ])
    );
    const provider = new OpenAiChatProvider({ id: 'c', kind: 'openai-compatible', preset: null, apiKey: null, baseUrl: `${server.url}/v1` });
    const model = fakeModel({ ref: { providerId: 'c', modelId: 'local-model' }, effort: null });
    const events = await collect(provider.streamText(request({ model }), new AbortController().signal));
    expect(events.filter((e) => e.type === 'block')).toEqual([
      { type: 'block', block: { type: 'text', text: 'Let me check.' } },
      { type: 'block', block: { type: 'tool_use', id: 'call_9', name: 'Grep', input: { pattern: 'TODO' } } }
    ]);
    expect(events.find((e) => e.type === 'usage')).toEqual({ type: 'usage', usage: { inputTokens: 20, outputTokens: 9, cacheReadTokens: 30, cacheWriteTokens: 0 } });
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool_use' });
    const body = server.requests[0]?.json() as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'local-model', stream: true, stream_options: { include_usage: true }, max_tokens: 8000 });
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('retries once without stream_options when a server rejects it', async () => {
    let calls = 0;
    server.route('POST', '/v1/chat/completions', async (req, res) => {
      calls++;
      if ((req.json() as Record<string, unknown>).stream_options) return json(res, 400, { error: { message: 'Unrecognized field stream_options' } });
      await sse(res, [{ data: { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] } }, { data: '[DONE]' }]);
    });
    const provider = new OpenAiChatProvider({ id: 'c', kind: 'openai-compatible', preset: null, apiKey: null, baseUrl: `${server.url}/v1` });
    const events = await collect(provider.streamText(request({ model: fakeModel({ effort: null }) }), new AbortController().signal));
    expect(calls).toBe(2);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('verifies OpenRouter keys against an authenticated endpoint and maps catalog metadata', async () => {
    server.route('GET', '/api/v1/key', (req, res) =>
      req.headers.authorization === 'Bearer good' ? json(res, 200, { data: { label: 'k' } }) : json(res, 401, { error: { message: 'No auth credentials found' } })
    );
    server.route('GET', '/api/v1/models', (_req, res) =>
      json(res, 200, {
        data: [
          {
            id: 'vendor/model-x',
            name: 'Vendor: Model X',
            description: 'A capable model for agents. It does many things.',
            context_length: 262_144,
            created: 1_750_000_000,
            architecture: { input_modalities: ['text', 'image'] },
            supported_parameters: ['tools', 'reasoning'],
            top_provider: { max_completion_tokens: 65_536 },
            pricing: { prompt: '0.000003', completion: '0.000015' }
          }
        ]
      })
    );
    const bad = new OpenAiChatProvider({ id: 'o', kind: 'openrouter', preset: null, apiKey: 'nope', baseUrl: `${server.url}/api/v1` });
    await expect(bad.listModels()).rejects.toMatchObject({ code: 'auth' });
    const good = new OpenAiChatProvider({ id: 'o', kind: 'openrouter', preset: null, apiKey: 'good', baseUrl: `${server.url}/api/v1` });
    const [model] = await good.listModels();
    expect(model).toMatchObject({
      label: 'Vendor: Model X',
      description: 'A capable model for agents.',
      contextWindow: 262_144,
      maxOutputTokens: 65_536,
      supportsVision: true,
      supportsTools: true,
      pricing: { input: 3, output: 15 }
    });
    expect(model?.effort?.levels).toEqual(['low', 'medium', 'high', 'taproot']);
  });

  it('turns tool results into tool-role messages and keeps images for vision models', () => {
    const messages = toChatMessages('sys', [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Read', input: { path: 'x' } }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'c1', isError: false, content: [{ type: 'text', text: 'file body' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
          { type: 'text', text: 'continue' }
        ]
      }
    ], true);
    expect(messages[1]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"path":"x"}' } }] });
    expect(messages[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'file body' });
    expect(messages[3]).toMatchObject({ role: 'user' });
    expect(JSON.stringify(messages[3])).toContain('data:image/png;base64,AAAA');
  });
});

describe('Gemini adapter', () => {
  let server: FixtureServer;
  beforeEach(async () => {
    server = await startFixtureServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it('filters the catalog, streams thoughts and function calls, and round-trips thought signatures', async () => {
    server.route('GET', '/v1beta/models', (_req, res) =>
      json(res, 200, {
        models: [
          { name: 'models/gen-pro-3', displayName: 'Gen Pro 3', inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, supportedGenerationMethods: ['generateContent'], thinking: true },
          { name: 'models/text-embedding-9', supportedGenerationMethods: ['embedContent'] }
        ]
      })
    );
    server.route('POST', /\/v1beta\/models\/gen-pro-3:streamGenerateContent/, (_req, res) =>
      sse(res, [
        { data: { candidates: [{ content: { role: 'model', parts: [{ text: 'Plan: search first.', thought: true }] } }] } },
        { data: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'Grep', args: { pattern: 'x' } }, thoughtSignature: 'ts-1' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 5, thoughtsTokenCount: 7 } } }
      ])
    );
    const provider = new GeminiProvider({ id: 'g', kind: 'gemini', preset: null, apiKey: 'AIza-test', baseUrl: `${server.url}/v1beta` });
    const models = await provider.listModels();
    expect(models.map((m) => m.ref.modelId)).toEqual(['gen-pro-3']);
    const events = await collect(provider.streamText(request({ model: models[0]!, effort: 'high' }), new AbortController().signal));
    const call = events.find((e) => e.type === 'block' && e.block.type === 'tool_use');
    expect(call).toMatchObject({ block: { name: 'Grep', input: { pattern: 'x' }, meta: { thoughtSignature: 'ts-1' } } });
    expect(events.find((e) => e.type === 'usage')).toMatchObject({ usage: { inputTokens: 40, outputTokens: 12 } });
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool_use' });
    const body = server.requests.at(-1)?.json() as Record<string, unknown>;
    expect(body.generationConfig).toMatchObject({ thinkingConfig: { includeThoughts: true, thinkingBudget: 10_000 } });
    expect(server.requests.at(-1)?.headers['x-goog-api-key']).toBe('AIza-test');

    const block = call?.type === 'block' ? call.block : null;
    const contents = toGeminiContents(
      [
        { role: 'assistant', content: [block!] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: block!.type === 'tool_use' ? block!.id : '', isError: false, content: [{ type: 'text', text: '3 matches' }] }] }
      ],
      true
    );
    expect(contents[0]?.parts[0]).toMatchObject({ functionCall: { name: 'Grep' }, thoughtSignature: 'ts-1' });
    expect(contents[1]?.parts[0]).toEqual({ functionResponse: { name: 'Grep', response: { output: '3 matches' } } });
  });

  it('reports an invalid key as an auth error', async () => {
    server.route('GET', '/v1beta/models', (_req, res) => json(res, 400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }));
    const provider = new GeminiProvider({ id: 'g', kind: 'gemini', preset: null, apiKey: 'bad', baseUrl: `${server.url}/v1beta` });
    await expect(provider.listModels()).rejects.toMatchObject({ code: 'auth' });
  });
});

describe('Ollama adapter', () => {
  let server: FixtureServer;
  beforeEach(async () => {
    server = await startFixtureServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it('reads capabilities from /api/show and streams NDJSON with tool calls', async () => {
    server.route('GET', '/api/tags', (_req, res) => json(res, 200, { models: [{ name: 'coder:7b', modified_at: '2026-09-01T00:00:00Z' }] }));
    server.route('POST', '/api/show', (_req, res) => json(res, 200, { capabilities: ['completion', 'tools', 'thinking'], model_info: { 'llama.context_length': 65536 } }));
    server.route('POST', '/api/chat', (_req, res) =>
      ndjson(res, [
        { message: { role: 'assistant', content: '', thinking: 'hmm' }, done: false },
        { message: { role: 'assistant', content: 'On it.' }, done: false },
        { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'Glob', arguments: { pattern: '**/*.ts' } } }] }, done: false },
        { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 30, eval_count: 8 }
      ])
    );
    const provider = new OllamaProvider({ id: 'l', kind: 'ollama', preset: null, apiKey: null, baseUrl: server.url });
    const [model] = await provider.listModels();
    // Measured against what Graft asks the server to hold, not what the model was trained for:
    // the server drops what does not fit without saying so.
    expect(model).toMatchObject({ contextWindow: 32768, supportsTools: true, supportsVision: false, effort: { levels: ['low', 'high', 'taproot'] } });
    expect(model!.description).toBe('32K of 64K context · reasoning');
    const events = await collect(provider.streamText(request({ model: model!, effort: 'high' }), new AbortController().signal));
    expect(events.filter((e) => e.type === 'block').map((e) => (e.type === 'block' ? e.block.type : ''))).toEqual(['thinking', 'text', 'tool_use']);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool_use' });
    const body = server.requests.at(-1)?.json() as Record<string, unknown>;
    expect(body).toMatchObject({ think: true, options: { num_ctx: 32768 } });
  });

  it('asks the server for the context it measures against: 32K, the size set in Settings, never more than the model has', async () => {
    const trained: Record<string, number> = { 'small:1b': 4096, 'coder:7b': 131072, 'big:70b': 131072, 'wide:9b': 65536, 'giant:480b-cloud': 262144, 'relayed:latest': 200_000 };
    // The last two are not run on this computer: the server passes them on to a hosted one, which has the whole window.
    const hosted: Record<string, object> = { 'relayed:latest': { remote_model: 'relayed', remote_host: 'https://models.example:443' } };
    server.route('GET', '/api/tags', (_req, res) => json(res, 200, { models: Object.keys(trained).map((name) => ({ name, ...hosted[name] })) }));
    server.route('POST', '/api/show', (req, res) => json(res, 200, { capabilities: ['completion', 'tools'], model_info: { 'llama.context_length': trained[(req.json() as { model: string }).model] } }));
    server.route('POST', '/api/chat', (_req, res) => ndjson(res, [{ message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 1 }]));
    const provider = new OllamaProvider({ id: 'l', kind: 'ollama', preset: null, apiKey: null, baseUrl: server.url }, [
      { id: 'big:70b', contextWindow: 65536 },
      { id: 'wide:9b', contextWindow: 200_000 },
      { id: 'not-installed:1b', contextWindow: 8192 }
    ]);
    const models = await provider.listModels();
    const window = Object.fromEntries(models.map((m) => [m.ref.modelId, m.contextWindow]));
    expect(window).toEqual({ 'small:1b': 4096, 'coder:7b': 32768, 'big:70b': 65536, 'wide:9b': 65536, 'giant:480b-cloud': 262144, 'relayed:latest': 200_000 });
    const said = Object.fromEntries(models.map((m) => [m.ref.modelId, m.description]));
    expect(said['small:1b']).toBe('4K context');
    expect(said['coder:7b']).toBe('32K of 128K context');
    expect(said['big:70b']).toBe('64K of 128K context');
    expect(said['wide:9b']).toBe('64K context');
    expect(said['giant:480b-cloud']).toBe('256K context');
    expect(said['relayed:latest']).toBe('200K context');
    for (const model of models) {
      await collect(provider.streamText(request({ model }), new AbortController().signal));
      const body = server.requests.at(-1)?.json() as { model: string; options: { num_ctx: number } };
      expect([body.model, body.options.num_ctx]).toEqual([model.ref.modelId, model.contextWindow]);
    }
  });

  it('explains when Ollama is not running', async () => {
    const closed = await startFixtureServer();
    const url = closed.url;
    await closed.close();
    const provider = new OllamaProvider({ id: 'l', kind: 'ollama', preset: null, apiKey: null, baseUrl: url });
    await expect(provider.listModels()).rejects.toThrow(/Ollama isn't reachable/);
  });

  it('rejects ports that fetch refuses with a base-URL error', async () => {
    const provider = new OllamaProvider({ id: 'l', kind: 'ollama', preset: null, apiKey: null, baseUrl: 'http://127.0.0.1:9' });
    await expect(provider.listModels()).rejects.toMatchObject({ code: 'bad_base_url', retryable: false });
  });
});
