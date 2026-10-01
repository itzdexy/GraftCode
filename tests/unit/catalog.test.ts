import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAiChatProvider, mergeReasoningDetail, toChatMessages } from '../../src/main/providers/openaiChat';
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

  it('asks for a real value when the preset URL still has a placeholder', () => {
    expect(() => new OpenAiChatProvider({ id: 'c', kind: 'openai-compatible', preset: 'x', apiKey: 'k', baseUrl: 'https://api.example.test/accounts/${ACCOUNT_ID}/v1' }, [], catalog)).toThrow(
      /Replace \$\{ACCOUNT_ID\}/
    );
  });
});
