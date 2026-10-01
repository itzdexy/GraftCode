import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SearchEngineSetting } from '../../src/shared/schemas/appSettings';
import {
  searchAnthropic,
  searchBrave,
  searchGemini,
  searchOpenAI,
  searchReaderModel,
  SearchService,
  searchTavily,
  tidyResults,
  type ProviderAccess,
  type ProviderEngine,
  type SearchDeps
} from '../../src/main/tools/web/search';
import { webSearchTool } from '../../src/main/tools/web/webSearch';
import { isPublicHost } from '../../src/main/app/favicons';
import { fakeModel } from '../support/fakeProvider';
import { json, startFixtureServer, type FixtureServer } from '../support/httpFixture';
import { makeToolContext } from '../support/toolContext';

let server: FixtureServer;
beforeEach(async () => {
  server = await startFixtureServer();
});
afterEach(async () => {
  await server.close();
});

function deps(
  partial: Omit<Partial<SearchDeps>, 'keys' | 'providers'> & {
    engine?: SearchEngineSetting;
    searxngUrl?: string | null;
    keys?: Record<string, string>;
    providers?: ProviderEngine[];
  }
): SearchDeps {
  const keys: Record<string, string> = partial.keys ?? {};
  return {
    settings: () => ({ engine: partial.engine ?? 'auto', searxngUrl: partial.searxngUrl ?? null }),
    noTraining: () => true,
    keys: { get: (id) => keys[id] ?? null, has: (id) => id in keys },
    providers: () => partial.providers ?? [],
    access: partial.access ?? (() => Promise.resolve(null))
  };
}

const signal = (): AbortSignal => new AbortController().signal;
const access = (path: string, model = 'm'): ProviderAccess => ({ baseUrl: `${server.url}${path}`, apiKey: 'key', model });

describe('search engines', () => {
  it('prefers an engine set up for search, then the default model’s provider, and respects "off"', () => {
    expect(new SearchService(deps({})).active()).toBeNull();
    expect(new SearchService(deps({ providers: ['gemini', 'openrouter'] })).active()).toBe('gemini');
    expect(new SearchService(deps({ providers: ['openrouter'], keys: { 'search:tavily': 'tvly-123456789' } })).active()).toBe('tavily');
    expect(new SearchService(deps({ engine: 'off', providers: ['openrouter'] })).active()).toBeNull();
    expect(new SearchService(deps({ engine: 'brave', providers: ['openrouter'] })).active()).toBeNull();
    expect(new SearchService(deps({ engine: 'anthropic', providers: ['openai', 'anthropic'] })).active()).toBe('anthropic');
  });

  it('reads Brave, Tavily and SearXNG results into one shape', async () => {
    server.route('GET', '/brave', (req, res) =>
      req.headers['x-subscription-token'] === 'brave-key'
        ? json(res, 200, { web: { results: [{ title: 'Roblox <strong>RIVALS</strong>', url: 'https://www.roblox.com/games/rivals', description: 'A <strong>fast</strong> shooter.' }] } })
        : json(res, 401, { error: 'bad key' })
    );
    server.route('POST', '/tavily', (req, res) =>
      req.headers.authorization === 'Bearer tvly-key'
        ? json(res, 200, { results: [{ title: 'Rivals wiki', url: 'https://rivals.fandom.com/wiki', content: 'History of the game.' }] })
        : json(res, 401, { detail: 'bad key' })
    );
    server.route('GET', '/search', (req, res) => {
      expect(req.path).toContain('format=json');
      json(res, 200, { results: [{ title: 'Self-hosted result', url: 'https://example.org/a', content: 'From SearXNG.' }] });
    });

    expect(tidyResults(await searchBrave('brave-key', 'rivals', 5, signal(), `${server.url}/brave`), 5)).toEqual([
      { title: 'Roblox RIVALS', url: 'https://www.roblox.com/games/rivals', snippet: 'A fast shooter.' }
    ]);
    expect(await searchTavily('tvly-key', 'rivals', 5, signal(), `${server.url}/tavily`)).toEqual([
      { title: 'Rivals wiki', url: 'https://rivals.fandom.com/wiki', snippet: 'History of the game.' }
    ]);
    await expect(searchBrave('wrong', 'rivals', 5, signal(), `${server.url}/brave`)).rejects.toMatchObject({ code: 'auth' });

    const searx = new SearchService(deps({ engine: 'searxng', searxngUrl: server.url }));
    expect(await searx.search('graft', 5, signal())).toEqual({
      engine: 'searxng',
      results: [{ title: 'Self-hosted result', url: 'https://example.org/a', snippet: 'From SearXNG.' }]
    });
  });

  it('searches through OpenRouter with the web plugin, keeping training out and merging citations with listed links', async () => {
    server.route('POST', '/api/v1/chat/completions', (req, res) => {
      const body = req.json() as Record<string, unknown>;
      expect(body).toMatchObject({ model: 'cheap/model', plugins: [{ id: 'web', max_results: 4 }], provider: { data_collection: 'deny' }, stream: false });
      expect(req.headers.authorization).toBe('Bearer key');
      json(res, 200, {
        choices: [
          {
            message: {
              content: '- [Rivals history](https://example.com/history): How it started.\n- [Patch notes](https://example.com/patches): Updates over time.',
              annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.com/history', title: 'Rivals history', content: '' } }]
            }
          }
        ]
      });
    });
    const service = new SearchService(deps({ providers: ['openrouter'], access: () => Promise.resolve(access('/api/v1', 'cheap/model')) }));
    const found = await service.search('rivals history', 4, signal());
    expect(found.engine).toBe('openrouter');
    expect(found.results).toEqual([
      { title: 'Rivals history', url: 'https://example.com/history', snippet: 'How it started.' },
      { title: 'Patch notes', url: 'https://example.com/patches', snippet: 'Updates over time.' }
    ]);
  });

  it('reads Anthropic’s web search results and the passages its answer cites', async () => {
    server.route('POST', '/v1/messages', (req, res) => {
      expect(req.headers['x-api-key']).toBe('key');
      expect(req.json()).toMatchObject({ model: 'claude-haiku', tools: [{ type: 'web_search_20250305', name: 'web_search' }] });
      json(res, 200, {
        content: [
          { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'rivals' } },
          {
            type: 'web_search_tool_result',
            tool_use_id: 's1',
            content: [
              { type: 'web_search_result', url: 'https://a.dev/rivals', title: 'Rivals on A', encrypted_content: 'x' },
              { type: 'web_search_result', url: 'https://b.dev/rivals', title: 'Rivals on B', encrypted_content: 'y' }
            ]
          },
          { type: 'text', text: 'It began as a zombie game.', citations: [{ type: 'web_search_result_location', url: 'https://a.dev/rivals', title: 'Rivals on A', cited_text: 'Started as PvE.' }] }
        ]
      });
    });
    expect(await searchAnthropic(access('', 'claude-haiku'), 'rivals', signal())).toEqual([
      { title: 'Rivals on A', url: 'https://a.dev/rivals', snippet: 'Started as PvE.' },
      { title: 'Rivals on B', url: 'https://b.dev/rivals', snippet: '' }
    ]);
  });

  it('reads OpenAI’s Responses web search: cited pages first, then the other sources', async () => {
    server.route('POST', '/v1/responses', (req, res) => {
      expect(req.json()).toMatchObject({ tools: [{ type: 'web_search' }], include: ['web_search_call.action.sources'], store: false });
      const text = 'RIVALS launched in 2024. It grew fast.';
      json(res, 200, {
        output: [
          { type: 'web_search_call', action: { type: 'search', query: 'rivals', sources: [{ type: 'url', url: 'https://c.dev/x' }, { type: 'url', url: 'https://d.dev/y' }] } },
          {
            type: 'message',
            content: [{ type: 'output_text', text, annotations: [{ type: 'url_citation', url: 'https://d.dev/y', title: 'D on Rivals', start_index: text.indexOf(' It'), end_index: text.length }] }]
          }
        ]
      });
    });
    expect(await searchOpenAI(access('/v1'), 'rivals', signal())).toEqual([
      { title: 'D on Rivals', url: 'https://d.dev/y', snippet: 'RIVALS launched in 2024.' },
      { title: '', url: 'https://c.dev/x', snippet: '' }
    ]);
  });

  it('reads Gemini’s grounding: redirect links named after their sites', async () => {
    server.route('POST', /\/v1beta\/models\/gemini-flash:generateContent$/, (req, res) => {
      expect(req.headers['x-goog-api-key']).toBe('key');
      expect(req.json()).toMatchObject({ tools: [{ google_search: {} }] });
      json(res, 200, {
        candidates: [
          {
            groundingMetadata: {
              groundingChunks: [{ web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'fandom.com' } }],
              groundingSupports: [{ segment: { text: 'RIVALS started as a zombie game.' }, groundingChunkIndices: [0] }]
            }
          }
        ]
      });
    });
    const results = tidyResults(await searchGemini(access('/v1beta', 'gemini-flash'), 'rivals', signal()), 5);
    expect(results).toEqual([
      { title: 'fandom.com', url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', snippet: 'RIVALS started as a zombie game.', site: 'fandom.com' }
    ]);
  });

  it('cleans results: http(s) only, no duplicates, capped', () => {
    expect(
      tidyResults(
        [
          { title: 'a', url: 'javascript:alert(1)', snippet: '' },
          { title: 'b', url: 'https://x.dev/1', snippet: '' },
          { title: 'b again', url: 'https://x.dev/1', snippet: '' },
          { title: 'c', url: 'https://x.dev/2', snippet: '' }
        ],
        1
      )
    ).toEqual([{ title: 'b', url: 'https://x.dev/1', snippet: '' }]);
  });

  it('runs searches on the cheapest model that can search and has room for the results', () => {
    const models = [
      fakeModel({ ref: { providerId: 'or', modelId: 'big/model' }, pricing: { input: 3, output: 15 } }),
      fakeModel({ ref: { providerId: 'or', modelId: 'free/model:free' }, pricing: { input: 0, output: 0 } }),
      fakeModel({ ref: { providerId: 'or', modelId: 'tiny/model' }, pricing: { input: 0.02, output: 0.05 }, contextWindow: 8000 }),
      fakeModel({ ref: { providerId: 'or', modelId: 'small/model' }, pricing: { input: 0.1, output: 0.4 } })
    ];
    expect(searchReaderModel('openrouter', models)).toBe('small/model');
    const openai = [
      fakeModel({ ref: { providerId: 'o', modelId: 'gpt-4.1-nano' }, pricing: { input: 0.1, output: 0.4 } }),
      fakeModel({ ref: { providerId: 'o', modelId: 'gpt-4.1-mini' }, pricing: { input: 0.4, output: 1.6 } }),
      fakeModel({ ref: { providerId: 'o', modelId: 'gpt-4.1' }, pricing: { input: 2, output: 8 } })
    ];
    expect(searchReaderModel('openai', openai)).toBe('gpt-4.1-mini');
    expect(searchReaderModel('anthropic', [fakeModel({ ref: { providerId: 'a', modelId: 'claude-3-haiku-20240307' } })])).toBeNull();
  });

  it('runs as the WebSearch tool: excerpts for the model, sites for the transcript, failures as errors', async () => {
    const ctx = makeToolContext(process.cwd());
    ctx.search = () =>
      Promise.resolve({
        engine: 'gemini',
        results: [{ title: 'fandom.com', url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', snippet: 'Fast PvP.', site: 'fandom.com' }]
      });
    const result = await webSearchTool.execute({ query: 'rivals' }, ctx);
    expect(result.isError).toBe(false);
    expect(result.display).toEqual({
      kind: 'web-search',
      query: 'rivals',
      results: [{ title: 'fandom.com', url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', site: 'fandom.com' }]
    });
    expect(JSON.stringify(result.content)).toContain('via Google Gemini');
    expect(JSON.stringify(result.content)).toContain('untrusted');

    ctx.search = () => Promise.reject(new Error('No web search engine is set up.'));
    const failed = await webSearchTool.execute({ query: 'rivals' }, ctx);
    expect(failed).toMatchObject({ isError: true, display: { kind: 'error', message: 'Web search failed: No web search engine is set up.' } });
  });
});

describe('site icons', () => {
  it('only fetches icons for public host names', () => {
    expect(isPublicHost('www.roblox.com')).toBe(true);
    expect(isPublicHost('rivals.fandom.com')).toBe(true);
    for (const host of ['localhost', '127.0.0.1', '10.0.0.8', 'router.local', 'intranet', 'printer.home', '[::1]', 'bad host.com']) {
      expect(isPublicHost(host), host).toBe(false);
    }
  });
});
