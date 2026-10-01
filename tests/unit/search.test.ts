import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SearchEngineSetting } from '../../src/shared/schemas/appSettings';
import { searchBrave, searchReaderModel, SearchService, searchTavily, tidyResults, type SearchDeps } from '../../src/main/tools/web/search';
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

function deps(partial: Omit<Partial<SearchDeps>, 'keys'> & { engine?: SearchEngineSetting; searxngUrl?: string | null; keys?: Record<string, string> }): SearchDeps {
  const keys: Record<string, string> = partial.keys ?? {};
  return {
    settings: () => ({ engine: partial.engine ?? 'auto', searxngUrl: partial.searxngUrl ?? null }),
    noTraining: () => true,
    keys: { get: (id) => keys[id] ?? null, has: (id) => id in keys },
    openRouter: partial.openRouter ?? (() => Promise.resolve(null)),
    hasOpenRouter: partial.hasOpenRouter ?? (() => false)
  };
}

const signal = (): AbortSignal => new AbortController().signal;

describe('search engines', () => {
  it('picks a key the user added before spending OpenRouter credits, and respects "off"', () => {
    expect(new SearchService(deps({})).active()).toBeNull();
    expect(new SearchService(deps({ hasOpenRouter: () => true })).active()).toBe('openrouter');
    expect(new SearchService(deps({ hasOpenRouter: () => true, keys: { 'search:tavily': 'tvly-123456789' } })).active()).toBe('tavily');
    expect(new SearchService(deps({ engine: 'off', hasOpenRouter: () => true })).active()).toBeNull();
    expect(new SearchService(deps({ engine: 'brave', hasOpenRouter: () => true })).active()).toBeNull();
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
      expect(req.headers.authorization).toBe('Bearer or-key');
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
    const service = new SearchService(
      deps({ hasOpenRouter: () => true, openRouter: () => Promise.resolve({ baseUrl: `${server.url}/api/v1`, apiKey: 'or-key', model: 'cheap/model' }) })
    );
    const found = await service.search('rivals history', 4, signal());
    expect(found.engine).toBe('openrouter');
    expect(found.results).toEqual([
      { title: 'Rivals history', url: 'https://example.com/history', snippet: 'How it started.' },
      { title: 'Patch notes', url: 'https://example.com/patches', snippet: 'Updates over time.' }
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

  it('reads results back with the cheapest paid model that has room for them', () => {
    const models = [
      fakeModel({ ref: { providerId: 'or', modelId: 'big/model' }, pricing: { input: 3, output: 15 } }),
      fakeModel({ ref: { providerId: 'or', modelId: 'free/model:free' }, pricing: { input: 0, output: 0 } }),
      fakeModel({ ref: { providerId: 'or', modelId: 'tiny/model' }, pricing: { input: 0.02, output: 0.05 }, contextWindow: 8000 }),
      fakeModel({ ref: { providerId: 'or', modelId: 'small/model' }, pricing: { input: 0.1, output: 0.4 } })
    ];
    expect(searchReaderModel(models)).toBe('small/model');
  });

  it('runs as the WebSearch tool: excerpts for the model, sites for the transcript, failures as errors', async () => {
    const ctx = makeToolContext(process.cwd());
    ctx.search = () => Promise.resolve({ engine: 'brave', results: [{ title: 'Rivals', url: 'https://rivals.example/a', snippet: 'Fast PvP.' }] });
    const result = await webSearchTool.execute({ query: 'rivals' }, ctx);
    expect(result.isError).toBe(false);
    expect(result.display).toEqual({ kind: 'web-search', query: 'rivals', results: [{ title: 'Rivals', url: 'https://rivals.example/a' }] });
    expect(JSON.stringify(result.content)).toContain('via Brave Search');
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
