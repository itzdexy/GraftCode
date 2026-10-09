import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { contextSize, OpenAiChatProvider, mergeReasoningDetail, smallerReplyBudget, toChatMessages } from '../../src/main/providers/openaiChat';
import { catalogEffort, ProviderCatalog, type CatalogModel } from '../../src/main/providers/presets';
import type { StreamEvent, StreamRequest } from '../../src/main/providers/types';
import type { LlmMessage } from '../../src/shared/schemas/messages';
import { json, sse, startFixtureServer, type FixtureServer } from '../support/httpFixture';

const SHIPPED = path.resolve(__dirname, '..', '..', 'resources', 'catalog', 'models.json');

async function collect(iterable: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of iterable) out.push(e);
  return out;
}

function meta(partial: Partial<CatalogModel>): CatalogModel {
  return {
    id: 'm',
    name: 'M',
    family: null,
    tools: true,
    vision: false,
    reasoning: true,
    effortValues: null,
    budget: null,
    toggle: false,
    interleaved: null,
    context: 100_000,
    output: 10_000,
    pricing: null,
    releasedAt: null,
    deprecated: false,
    missing: false,
    capabilities: { tools: true, vision: false, reasoning: true, audio: null, structured: null },
    ...partial
  };
}

describe('shipped provider catalog', () => {
  const catalog = new ProviderCatalog(SHIPPED);

  it('offers more than 200 providers, including the built-in ones', () => {
    const presets = catalog.presets();
    expect(presets.length).toBeGreaterThan(200);
    expect(presets.find((p) => p.id === 'openrouter')).toMatchObject({ kind: 'openrouter', key: 'required' });
    expect(presets.find((p) => p.id === 'anthropic')).toMatchObject({ kind: 'anthropic' });
    expect(presets.find((p) => p.id === 'ollama')).toMatchObject({ kind: 'ollama', key: 'none', local: true });
    expect(presets.find((p) => p.id === 'deepseek')).toMatchObject({ kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com' });
    expect(presets.find((p) => p.id === 'groq')?.baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(presets.find((p) => p.id === 'lmstudio')).toMatchObject({ key: 'optional', local: true });
    // Every OpenAI-compatible preset has a base URL to start from.
    expect(presets.filter((p) => p.kind === 'openai-compatible' && !p.baseUrl)).toEqual([]);
  });

  it('has model metadata the adapters use', () => {
    const models = catalog.models('openrouter');
    expect(models.length).toBeGreaterThan(100);
    const withEffort = models.find((m) => m.effortValues && m.effortValues.length > 0);
    expect(withEffort?.effortValues).toEqual(expect.arrayContaining(['high']));
    expect(catalog.model('openrouter', withEffort!.id)?.id).toBe(withEffort!.id);
    expect(catalog.model('openrouter', 'no/such-model')).toBeNull();
  });

  it('degrades to an empty catalog when the file is missing', () => {
    const empty = new ProviderCatalog(path.join(os.tmpdir(), 'graft-no-catalog.json'));
    expect(empty.presets().map((p) => p.id)).toEqual(['ollama']);
    expect(empty.model('openrouter', 'x')).toBeNull();
  });
});

describe('effort levels from the catalog', () => {
  it('maps named provider levels, including minimal, xhigh and none', () => {
    const effort = catalogEffort(meta({ effortValues: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] }), { reasoning: true, fallback: [], allowOff: true, budgets: false });
    expect(effort?.levels).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'extra', 'taproot']);
    expect(effort?.values).toMatchObject({ none: 'none', minimal: 'minimal', extra: 'xhigh', taproot: 'xhigh' });
    expect(effort?.default).toBe('medium');
  });

  it('adds Off for switchable reasoning only where allowed, and uses budgets when asked', () => {
    const toggled = meta({ toggle: true });
    expect(catalogEffort(toggled, { reasoning: true, fallback: ['low', 'medium', 'high'], allowOff: true, budgets: false })?.levels).toEqual(['none', 'low', 'medium', 'high', 'taproot']);
    expect(catalogEffort(toggled, { reasoning: true, fallback: [], allowOff: false, budgets: false })).toBeNull();
    const budget = catalogEffort(meta({ budget: { min: 1024, max: 32_000 } }), { reasoning: true, fallback: [], allowOff: false, budgets: true });
    expect(budget?.values).toMatchObject({ low: 2048, medium: 8192, high: 16_000, extra: 24_000, max: 32_000, taproot: 32_000 });
  });

  it('gives no control to models without reasoning', () => {
    expect(catalogEffort(meta({ reasoning: false }), { reasoning: false, fallback: ['low', 'high'], allowOff: true, budgets: true })).toBeNull();
    expect(catalogEffort(null, { reasoning: false, fallback: ['low'], allowOff: true, budgets: true })).toBeNull();
  });
});

describe('reasoning round trips', () => {
  it('merges streamed reasoning_details fragments by index', () => {
    const details: Array<Record<string, unknown>> = [];
    mergeReasoningDetail(details, { type: 'reasoning.text', index: 0, text: 'Let me ', format: 'anthropic-claude-v1' });
    mergeReasoningDetail(details, { type: 'reasoning.text', index: 0, text: 'think.' });
    mergeReasoningDetail(details, { type: 'reasoning.text', index: 0, signature: 'sig-1' });
    mergeReasoningDetail(details, { type: 'reasoning.encrypted', index: 1, data: 'abc' });
    expect(details).toEqual([
      { type: 'reasoning.text', index: 0, text: 'Let me think.', format: 'anthropic-claude-v1', signature: 'sig-1' },
      { type: 'reasoning.encrypted', index: 1, data: 'abc' }
    ]);
  });

  it('replays reasoning_content only inside the current tool loop', () => {
    const replay = (content: string): LlmMessage['content'] => [{ type: 'provider', provider: 'openai-compatible', raw: { model: 'r1', reasoning_content: content }, summary: '' }];
    const history: LlmMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'first question' }] },
      { role: 'assistant', content: [...replay('old thoughts'), { type: 'text', text: 'old answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'second question' }] },
      { role: 'assistant', content: [...replay('new thoughts'), { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: [{ type: 'text', text: 'file' }], isError: false }] }
    ];
    const out = toChatMessages('sys', history, false, { kind: 'openai-compatible', model: 'r1' });
    const assistants = out.filter((m) => m.role === 'assistant');
    expect(assistants[0]).not.toHaveProperty('reasoning_content');
    expect(assistants[1]).toMatchObject({ reasoning_content: 'new thoughts' });
    // Another model never receives it.
    expect(toChatMessages('sys', history, false, { kind: 'openai-compatible', model: 'other' }).filter((m) => m.role === 'assistant')[1]).not.toHaveProperty('reasoning_content');
  });
});

describe('catalog-backed OpenAI-style providers', () => {
  let server: FixtureServer;
  let dir: string;
  let catalog: ProviderCatalog;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-catalog-'));
    const file = path.join(dir, 'models.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        providers: [
          {
            id: 'openrouter',
            name: 'OpenRouter',
            kind: 'openrouter',
            api: 'https://openrouter.ai/api/v1',
            env: ['OPENROUTER_API_KEY'],
            doc: null,
            key: 'required',
            models: [{ id: 'vendor/thinker', n: 'Thinker', t: 1, r: 1, g: 1, e: ['low', 'medium', 'high', 'xhigh', 'max'], c: 200000, o: 64000 }]
          },
          {
            id: 'acme',
            name: 'Acme AI',
            kind: 'openai-compatible',
            api: 'https://api.acme.test/v1',
            env: ['ACME_API_KEY'],
            doc: null,
            key: 'required',
            models: [
              { id: 'acme-reasoner', n: 'Acme Reasoner', t: 1, r: 1, e: ['low', 'high'], i: 'reasoning_content', c: 128000, o: 32000, p: [1, 2] },
              { id: 'acme-old', n: 'Acme Old', t: 1, s: 'deprecated' }
            ]
          }
        ]
      })
    );
    catalog = new ProviderCatalog(file);
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    server = await startFixtureServer();
  });
  afterEach(async () => {
    await server.close();
  });

  function request(
    model: StreamRequest['model'],
    messages: LlmMessage[],
    effort: StreamRequest['effort'],
    privacy: StreamRequest['privacy'] = { noTraining: false, zeroRetention: false }
  ): StreamRequest {
    return { model, system: 'sys', messages, tools: [], effort, webSearch: false, cacheKey: 's1', privacy };
  }

  it('OpenRouter: offers the catalog levels, sends the native effort and replays reasoning_details', async () => {
    server.route('GET', '/api/v1/key', (_req, res) => json(res, 200, { data: {} }));
    server.route('GET', '/api/v1/models', (_req, res) =>
      json(res, 200, { data: [{ id: 'vendor/thinker', name: 'Vendor: Thinker', context_length: 200000, supported_parameters: ['tools', 'reasoning'], architecture: { input_modalities: ['text'] } }] })
    );
    server.route('POST', '/api/v1/chat/completions', (_req, res) =>
      sse(res, [
        { data: { choices: [{ index: 0, delta: { reasoning: 'Plan', reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'Plan', format: 'f1' }] } }] } },
        { data: { choices: [{ index: 0, delta: { reasoning_details: [{ type: 'reasoning.text', index: 0, signature: 's' }] } }] } },
        { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'Read', arguments: '{}' } }] } }] } },
        { data: { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] } },
        { data: '[DONE]' }
      ])
    );
    const provider = new OpenAiChatProvider({ id: 'or', kind: 'openrouter', preset: 'openrouter', apiKey: 'k', baseUrl: `${server.url}/api/v1` }, [], catalog);
    const [model] = await provider.listModels();
    expect(model?.effort?.levels).toEqual(['none', 'low', 'medium', 'high', 'extra', 'max', 'taproot']);

    const first = await collect(provider.streamText(request(model!, [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], 'extra'), new AbortController().signal));
    const body = server.requests.find((r) => r.path.endsWith('/chat/completions'))?.json() as Record<string, unknown>;
    expect(body.reasoning).toEqual({ effort: 'xhigh' });
    const blocks = first.filter((e) => e.type === 'block').map((e) => (e.type === 'block' ? e.block : null));
    const saved = blocks.find((b) => b?.type === 'provider');
    expect(saved).toMatchObject({ provider: 'openrouter', raw: { model: 'vendor/thinker', reasoning_details: [{ type: 'reasoning.text', text: 'Plan', signature: 's' }] } });

    const history: LlmMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: blocks.filter((b): b is NonNullable<typeof b> => b !== null) },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false }] }
    ];
    await collect(provider.streamText(request(model!, history, 'none'), new AbortController().signal));
    const second = server.requests.filter((r) => r.path.endsWith('/chat/completions'))[1]?.json() as { messages: Array<Record<string, unknown>>; reasoning: unknown };
    expect(second.reasoning).toEqual({ effort: 'none' });
    expect(second.messages.find((m) => m.role === 'assistant')).toMatchObject({ reasoning_details: [{ type: 'reasoning.text', text: 'Plan', signature: 's' }] });
  });

  it('OpenRouter: caches Claude prompts at a breakpoint and reports cache writes and the charged cost', async () => {
    server.route('GET', '/api/v1/key', (_req, res) => json(res, 200, { data: {} }));
    server.route('GET', '/api/v1/models', (_req, res) =>
      json(res, 200, {
        data: [
          {
            id: 'anthropic/claude-test',
            name: 'Anthropic: Claude Test',
            context_length: 200000,
            supported_parameters: ['tools'],
            pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003', input_cache_write: '0.00000375' }
          },
          { id: 'vendor/other', name: 'Vendor: Other', context_length: 100000, supported_parameters: ['tools'] }
        ]
      })
    );
    server.route('POST', '/api/v1/chat/completions', (_req, res) =>
      sse(res, [
        { data: { choices: [{ index: 0, delta: { content: 'Hi.' }, finish_reason: 'stop' }] } },
        {
          data: {
            choices: [],
            usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 }, cost: 0.0002, cost_details: { upstream_inference_cost: 0.004 } }
          }
        },
        { data: '[DONE]' }
      ])
    );
    const provider = new OpenAiChatProvider({ id: 'or', kind: 'openrouter', preset: 'openrouter', apiKey: 'k', baseUrl: `${server.url}/api/v1` }, [], catalog);
    const models = await provider.listModels();
    const claude = models.find((m) => m.ref.modelId === 'anthropic/claude-test')!;
    const other = models.find((m) => m.ref.modelId === 'vendor/other')!;
    expect(claude.pricing).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });

    const hi: LlmMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    const events = await collect(provider.streamText(request(claude, hi, null), new AbortController().signal));
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toMatchObject({ usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 600, cacheWriteTokens: 300 } });
    // With your own upstream key, OpenRouter's fee and the upstream bill add up.
    expect(usage?.type === 'usage' ? usage.costUsd : null).toBeCloseTo(0.0042, 10);

    await collect(provider.streamText(request(other, hi, null), new AbortController().signal));
    const [toClaude, toOther] = server.requests.filter((r) => r.path.endsWith('/chat/completions')).map((r) => r.json() as Record<string, unknown>);
    expect(toClaude?.cache_control).toEqual({ type: 'ephemeral' });
    expect(toOther).not.toHaveProperty('cache_control');
  });

  it('OpenRouter: asks for providers that do not train, zero retention for incognito, and explains a refusal', async () => {
    let refuse = false;
    server.route('POST', '/api/v1/chat/completions', (_req, res) =>
      refuse
        ? json(res, 404, { error: { message: 'No endpoints found matching your data policy (Zero data retention).', code: 404 } })
        : sse(res, [{ data: { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] } }, { data: '[DONE]' }])
    );
    const provider = new OpenAiChatProvider({ id: 'or', kind: 'openrouter', preset: 'openrouter', apiKey: 'k', baseUrl: `${server.url}/api/v1` }, [], catalog);
    const model = { ...(await import('../support/fakeProvider')).fakeModel({ ref: { providerId: 'or', modelId: 'vendor/model' }, effort: null }) };
    const hi: LlmMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    const send = (privacy: StreamRequest['privacy']) => collect(provider.streamText(request(model, hi, null, privacy), new AbortController().signal));

    await send({ noTraining: false, zeroRetention: false });
    await send({ noTraining: true, zeroRetention: false });
    await send({ noTraining: true, zeroRetention: true });
    const bodies = server.requests.map((r) => r.json() as Record<string, unknown>);
    expect(bodies[0]).not.toHaveProperty('provider');
    expect(bodies[1]?.provider).toEqual({ data_collection: 'deny' });
    expect(bodies[2]?.provider).toEqual({ data_collection: 'deny', zdr: true });

    refuse = true;
    await expect(send({ noTraining: true, zeroRetention: true })).rejects.toMatchObject({
      code: 'bad_request',
      retryable: false,
      message: expect.stringContaining("this incognito chat can't use it") as unknown
    });
    await expect(send({ noTraining: true, zeroRetention: false })).rejects.toMatchObject({
      message: expect.stringContaining('Settings → Privacy') as unknown
    });
  });

  it('OpenAI: asks the API not to store responses', async () => {
    server.route('POST', '/v1/chat/completions', (_req, res) =>
      sse(res, [{ data: { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] } }, { data: '[DONE]' }])
    );
    const provider = new OpenAiChatProvider({ id: 'oa', kind: 'openai', preset: 'openai', apiKey: 'k', baseUrl: `${server.url}/v1` }, [], catalog);
    const model = (await import('../support/fakeProvider')).fakeModel({ ref: { providerId: 'oa', modelId: 'gpt-test' }, effort: null });
    await collect(provider.streamText(request(model, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], null), new AbortController().signal));
    const body = server.requests[0]?.json() as Record<string, unknown>;
    expect(body.store).toBe(false);
    expect(body).not.toHaveProperty('provider');
  });

  it('a compatible preset uses catalog metadata, reasoning_effort and drops it when the server refuses', async () => {
    server.route('GET', '/v1/models', (_req, res) => json(res, 200, { data: [{ id: 'acme-reasoner' }, { id: 'acme-embed-large' }] }));
    let calls = 0;
    server.route('POST', '/v1/chat/completions', (req, res) => {
      calls++;
      const body = req.json() as Record<string, unknown>;
      if ('reasoning_effort' in body) return json(res, 400, { error: { message: 'Unrecognized request argument supplied: reasoning_effort' } });
      return sse(res, [
        { data: { choices: [{ index: 0, delta: { reasoning_content: 'hmm' } }] } },
        { data: { choices: [{ index: 0, delta: { content: 'Done.' } }] } },
        { data: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
        { data: '[DONE]' }
      ]);
    });
    const provider = new OpenAiChatProvider({ id: 'a', kind: 'openai-compatible', preset: 'acme', apiKey: 'k', baseUrl: `${server.url}/v1` }, [], catalog);
    const models = await provider.listModels();
    expect(models.map((m) => m.ref.modelId)).toEqual(['acme-reasoner']);
    expect(models[0]).toMatchObject({ label: 'Acme Reasoner', contextWindow: 128000, maxOutputTokens: 32000, pricing: { input: 1, output: 2 } });
    expect(models[0]?.effort?.levels).toEqual(['low', 'high', 'taproot']);

    const events = await collect(provider.streamText(request(models[0]!, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], 'high'), new AbortController().signal));
    expect(calls).toBe(2);
    expect((server.requests.filter((r) => r.method === 'POST')[0]?.json() as Record<string, unknown>).reasoning_effort).toBe('high');
    expect(events.filter((e) => e.type === 'block').map((e) => (e.type === 'block' ? e.block.type : ''))).toEqual(['thinking', 'provider', 'text']);
  });

  it('falls back to the catalog when a preset has no list endpoint, after checking the key', async () => {
    server.route('POST', '/v1/chat/completions', (_req, res) => json(res, 200, { choices: [{ index: 0, message: { role: 'assistant', content: 'O' } }] }));
    const provider = new OpenAiChatProvider({ id: 'a', kind: 'openai-compatible', preset: 'acme', apiKey: 'k', baseUrl: `${server.url}/v1` }, [], catalog);
    const models = await provider.listModels();
    expect(models.map((m) => m.ref.modelId)).toEqual(['acme-reasoner']);
    const ping = server.requests.find((r) => r.method === 'POST')?.json() as Record<string, unknown>;
    expect(ping).toMatchObject({ model: 'acme-reasoner', max_tokens: 1, stream: false });

    server.route('POST', '/v2/chat/completions', (_req, res) => json(res, 401, { error: { message: 'bad key' } }));
    const wrong = new OpenAiChatProvider({ id: 'b', kind: 'openai-compatible', preset: 'acme', apiKey: 'k', baseUrl: `${server.url}/v2` }, [], catalog);
    await expect(wrong.listModels()).rejects.toMatchObject({ code: 'auth' });
  });

  describe('how large a model is', () => {
    /** A catalog whose providers answer at the fixture server, the way a real provider's entry names its real address. */
    function catalogAt(providers: Array<{ id: string; api: string | null; models: object[] }>): ProviderCatalog {
      const file = path.join(dir, `sizes-${String(Math.random()).slice(2)}.json`);
      fs.writeFileSync(file, JSON.stringify({ providers: providers.map((p) => ({ name: p.id, kind: 'openai-compatible', env: [], doc: null, key: 'required', ...p })) }));
      return new ProviderCatalog(file);
    }

    it('a custom endpoint at a known provider’s address gets that provider’s sizes (regression: every model there was 32K)', async () => {
      // The server names its models and nothing else, as many do.
      server.route('GET', '/v1/models', (_req, res) => json(res, 200, { data: [{ id: 'moonshotai/kimi-k3' }, { id: 'nvidia/nemotron-3-ultra' }] }));
      const known = catalogAt([
        { id: 'elsewhere', api: 'https://api.elsewhere.test/v1', models: [{ id: 'moonshotai/kimi-k3', n: 'Wrong', t: 1, c: 8000, o: 1000 }] },
        {
          id: 'nim',
          api: `${server.url}/v1`,
          models: [
            { id: 'moonshotai/kimi-k3', n: 'Kimi K3', t: 1, v: 1, c: 1048576, o: 131072 },
            { id: 'nvidia/nemotron-3-ultra', n: 'Nemotron 3 Ultra', t: 1, c: 1000000, o: 65536 }
          ]
        }
      ]);
      // Added by typing the address: the connection names no preset. A trailing slash and upper case don't matter.
      const typed = `${server.url.replace('http://', 'HTTP://')}/v1/`;
      const provider = new OpenAiChatProvider({ id: 'n', kind: 'openai-compatible', preset: null, apiKey: 'k', baseUrl: typed }, [], known);
      const models = await provider.listModels();
      expect(Object.fromEntries(models.map((m) => [m.ref.modelId, [m.contextWindow, m.maxOutputTokens]]))).toEqual({
        'moonshotai/kimi-k3': [1048576, 131072],
        'nvidia/nemotron-3-ultra': [1000000, 65536]
      });
      expect(models.find((m) => m.ref.modelId === 'moonshotai/kimi-k3')).toMatchObject({ label: 'Kimi K3', supportsVision: true });
    });

    it('believes what a server says about its own models, under the names servers use for it', async () => {
      server.route('GET', '/v1/models', (_req, res) =>
        json(res, 200, {
          data: [
            { id: 'a', context_window: 131072, max_completion_tokens: 32768 },
            { id: 'b', context_length: 262144 },
            { id: 'c', max_context_length: 128000 },
            { id: 'd', max_model_len: 65536 },
            { id: 'e', metadata: { context_length: 200000, max_tokens: 16000 } },
            { id: 'f', meta: { n_ctx_train: 40960 } },
            { id: 'g', limits: { max_input_tokens: 1000000, max_output_tokens: 64000 } },
            { id: 'h', capabilities: { limits: { max_context_window_tokens: 400000, max_output_tokens: 128000 } } },
            { id: 'i', context_size: '204800' },
            // The server's own figure is for this server: it wins over the catalog's.
            { id: 'acme-reasoner', context_length: 64000 }
          ]
        })
      );
      const provider = new OpenAiChatProvider({ id: 's', kind: 'openai-compatible', preset: 'acme', apiKey: 'k', baseUrl: `${server.url}/v1` }, [], catalog);
      const models = await provider.listModels();
      expect(Object.fromEntries(models.map((m) => [m.ref.modelId, m.contextWindow]))).toEqual({
        a: 131072,
        b: 262144,
        c: 128000,
        d: 65536,
        e: 200000,
        f: 40960,
        g: 1000000,
        h: 400000,
        i: 204800,
        'acme-reasoner': 64000
      });
      const output = Object.fromEntries(models.map((m) => [m.ref.modelId, m.maxOutputTokens]));
      expect([output.a, output.e, output.g, output.h, output['acme-reasoner']]).toEqual([32768, 16000, 64000, 128000, 32000]);
    });

    it('knows what most providers give for a model of a name, whatever account or case it is listed under', () => {
      const known = catalogAt([
        { id: 'p1', api: 'https://p1.test/v1', models: [{ id: 'vendor/big-model', n: 'Big', t: 1, v: 1, c: 1000000, o: 64000 }, { id: 'small-model', n: 'Small', t: 1, c: 16000 }] },
        { id: 'p2', api: 'https://p2.test/v1', models: [{ id: 'big-model', n: 'Big', t: 1, c: 1000000 }, { id: 'small-model', n: 'Small', t: 1, c: 8000 }] },
        { id: 'p3', api: 'https://p3.test/v1', models: [{ id: 'Vendor/Big-Model', n: 'Big', t: 1, c: 262144 }] },
        { id: 'p4', api: 'https://p4.test/v1', models: [{ id: 'big-model', n: 'Big', t: 1 }] }
      ]);
      expect(known.typicalContext('accounts/acme/models/Big-Model')).toBe(1000000);
      expect(known.typicalContext('big-model:free')).toBe(1000000);
      expect(known.typicalContext('never-heard-of-it')).toBeNull();
      // A tie goes to the larger window: too small a guess costs every turn, too large a one is corrected the first time it matters.
      expect(known.typicalContext('small-model')).toBe(16000);
    });

    it('takes the best source that says how large a model is, and says so when none does', () => {
      const nothing = { reported: null, listed: null, typical: null };
      // The server's own figure, then its provider's entry, then (hosted only) the usual size for the name.
      expect(contextSize({ reported: 64_000, listed: 128_000, typical: 1_000_000, local: false })).toEqual({ tokens: 64_000, assumed: false });
      expect(contextSize({ reported: null, listed: 128_000, typical: 1_000_000, local: false })).toEqual({ tokens: 128_000, assumed: false });
      expect(contextSize({ ...nothing, typical: 1_000_000, local: false })).toEqual({ tokens: 1_000_000, assumed: false });
      // A server on this computer runs with the window it was started with, whatever the model could hold elsewhere.
      expect(contextSize({ ...nothing, typical: 1_000_000, local: true })).toEqual({ tokens: 32_768, assumed: true });
      expect(contextSize({ reported: 8192, listed: null, typical: 1_000_000, local: true })).toEqual({ tokens: 8192, assumed: false });
      // Nothing known: nine in ten hosted models have 128,000 tokens or more.
      expect(contextSize({ ...nothing, local: false })).toEqual({ tokens: 128_000, assumed: true });
      expect(contextSize({ ...nothing, local: true })).toEqual({ tokens: 32_768, assumed: true });
    });

    it('marks a size nothing vouches for as assumed in the model’s description', async () => {
      server.route('GET', '/v1/models', (_req, res) => json(res, 200, { data: [{ id: 'never-heard-of-it' }, { id: 'acme-reasoner' }, { id: 'vendor/thinker' }] }));
      const provider = new OpenAiChatProvider({ id: 'u', kind: 'openai-compatible', preset: 'acme', apiKey: 'k', baseUrl: `${server.url}/v1` }, [], catalog);
      const models = await provider.listModels();
      // The test server is on this computer: an unknown model gets the local size, and a name known elsewhere is not trusted here.
      expect(models.find((m) => m.ref.modelId === 'never-heard-of-it')).toMatchObject({ contextWindow: 32_768, description: '32K context (assumed)' });
      expect(models.find((m) => m.ref.modelId === 'vendor/thinker')).toMatchObject({ contextWindow: 32_768, description: '32K context (assumed)' });
      expect(models.find((m) => m.ref.modelId === 'acme-reasoner')?.description).toBe('128K context · reasoning');
    });

    it('works out a smaller reply budget from a server’s refusal, and leaves a prompt that is too long alone', () => {
      // The most the server allows, however it words it.
      expect(smallerReplyBudget('max_tokens is too large: 64000. This model supports at most 8192 completion tokens.', 64_000)).toBe(8192);
      expect(smallerReplyBudget('Invalid max_tokens value, the valid range of max_tokens is [1, 8192]', 64_000)).toBe(8192);
      expect(smallerReplyBudget('`max_tokens` must be less than or equal to `16384`', 64_000)).toBe(16_384);
      // The window minus the prompt, when the server counts the reply against its window.
      const counted = "This model's maximum context length is 131072 tokens. However, you requested 140000 tokens (76000 in the messages, 64000 in the completion).";
      expect(smallerReplyBudget(counted, 64_000)).toBe(131_072 - 76_000 - 64);
      expect(smallerReplyBudget('`inputs` tokens + `max_new_tokens` must be <= 32768. Given: 6000 `inputs` tokens and 64000 `max_new_tokens`', 64_000)).toBe(32_768 - 6000 - 64);
      // The prompt alone is too long: a smaller reply would not help, summarizing will.
      expect(smallerReplyBudget("This model's maximum context length is 32768 tokens. However, you requested 100000 tokens (36000 in the messages, 64000 in the completion).", 64_000)).toBeNull();
      expect(smallerReplyBudget('prompt is too long: 250000 tokens > 200000 maximum', 64_000)).toBeNull();
      // Not about the reply budget at all.
      expect(smallerReplyBudget('Unrecognized request argument supplied: reasoning_effort', 64_000)).toBeNull();
      // Named, but with no figure to go by: the modest budget every server takes, once.
      expect(smallerReplyBudget('max_tokens is too large', 64_000)).toBe(8192);
      expect(smallerReplyBudget('max_tokens is too large', 8192)).toBeNull();
    });

    it('retries with a smaller reply budget when a server refuses the one its catalog entry suggests, and remembers it', async () => {
      server.route('GET', '/v1/models', (_req, res) => json(res, 200, { data: [{ id: 'acme-reasoner' }] }));
      server.route('POST', '/v1/chat/completions', (req, res) => {
        const sent = (req.json() as { max_tokens: number }).max_tokens;
        if (sent > 8192) return json(res, 400, { error: { message: `max_tokens is too large: ${String(sent)}. This model supports at most 8192 completion tokens.` } });
        return sse(res, [{ data: { choices: [{ index: 0, delta: { content: 'Done.' } }] } }, { data: { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } }, { data: '[DONE]' }]);
      });
      const provider = new OpenAiChatProvider({ id: 'r', kind: 'openai-compatible', preset: 'acme', apiKey: 'k', baseUrl: `${server.url}/v1` }, [], catalog);
      const model = (await provider.listModels())[0]!;
      const ask = (): Promise<StreamEvent[]> => collect(provider.streamText(request(model, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], null), new AbortController().signal));
      const first = await ask();
      expect(first.some((e) => e.type === 'block' && e.block.type === 'text' && e.block.text === 'Done.')).toBe(true);
      await ask();
      const budgets = server.requests.filter((r) => r.method === 'POST').map((r) => (r.json() as { max_tokens: number }).max_tokens);
      // The catalog says 32,000; the server takes 8,192: one refusal, then the smaller budget from the start.
      expect(budgets).toEqual([32_000, 8192, 8192]);
    });

    it('finds a provider by its address in the shipped catalog', () => {
      const shipped = new ProviderCatalog(SHIPPED);
      expect(shipped.presetsForUrl('https://integrate.api.nvidia.com/v1')).toEqual(['nvidia']);
      expect(shipped.presetsForUrl('https://INTEGRATE.api.nvidia.com/v1/')).toEqual(['nvidia']);
      expect(shipped.presetsForUrl('https://api.groq.com/openai/v1')).toEqual(['groq']);
      // Two entries at one address are both consulted, the larger first.
      expect(shipped.presetsForUrl('https://api.llmgateway.io/v1')).toEqual(['llmgateway-providers', 'llmgateway']);
      expect(shipped.presetsForUrl('https://my-own-gateway.example/v1')).toEqual([]);
      expect(shipped.presetsForUrl('not an address')).toEqual([]);
    });
  });

  it('asks for a real value when the preset URL still has a placeholder', () => {
    expect(() => new OpenAiChatProvider({ id: 'c', kind: 'openai-compatible', preset: 'x', apiKey: 'k', baseUrl: 'https://api.example.test/accounts/${ACCOUNT_ID}/v1' }, [], catalog)).toThrow(
      /Replace \$\{ACCOUNT_ID\}/
    );
  });
});
