import type { SearchEngineId, SearchEngineSetting } from '@shared/schemas/appSettings';
import type { ModelInfo } from '@shared/schemas/models';
import { ProviderError } from '../../providers/errors';
import { joinUrl, requestJson } from '../../providers/http';

/**
 * Web search for the WebSearch tool, behind one interface. Engines:
 * - openrouter: one small request with OpenRouter's web plugin, using the
 *   user's OpenRouter key and a low-cost model; results come back as citations.
 * - brave / tavily: their search APIs with the user's own key.
 * - searxng: a SearXNG instance's JSON API (often self-hosted).
 * Results are untrusted web content; callers must never follow instructions in them.
 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type { SearchEngineId } from '@shared/schemas/appSettings';

export const SEARCH_ENGINE_LABELS: Record<SearchEngineId, string> = {
  openrouter: 'OpenRouter',
  brave: 'Brave Search',
  tavily: 'Tavily',
  searxng: 'SearXNG'
};

/** KeyStore id of a search engine's API key. */
export function searchKeyId(engine: 'brave' | 'tavily'): string {
  return `search:${engine}`;
}

export interface OpenRouterAccess {
  baseUrl: string;
  apiKey: string;
  /** Low-cost model that reads the results back. */
  model: string;
}

/** Cheapest paid model with room for the results; free models often log prompts and are rate limited. */
export function searchReaderModel(models: ModelInfo[]): string | null {
  const cost = (m: ModelInfo): number => (m.pricing ? m.pricing.input + m.pricing.output : Number.POSITIVE_INFINITY);
  const paid = models
    .filter((m) => m.pricing !== null && m.pricing.input > 0 && m.contextWindow >= 16_000 && !m.ref.modelId.endsWith(':free'))
    .sort((a, b) => cost(a) - cost(b));
  return (paid[0] ?? models[0])?.ref.modelId ?? null;
}

export interface SearchDeps {
  settings(): { engine: SearchEngineSetting; searxngUrl: string | null };
  /** Settings → Privacy: keep OpenRouter away from providers that train on prompts. */
  noTraining(): boolean;
  keys: { get(id: string): string | null; has(id: string): boolean };
  openRouter(signal?: AbortSignal): Promise<OpenRouterAccess | null>;
  /** True when an OpenRouter provider with a key exists (no network). */
  hasOpenRouter(): boolean;
}

const TIMEOUT = 30_000;

function clean(text: unknown, max = 400): string {
  if (typeof text !== 'string') return '';
  const plain = text
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

function isWebUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    return /^https?:$/.test(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Keeps http(s) results, drops duplicates, caps the count. */
export function tidyResults(results: SearchResult[], count: number): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    if (!isWebUrl(r.url) || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push({ title: clean(r.title, 200) || new URL(r.url).hostname, url: r.url, snippet: clean(r.snippet) });
    if (out.length >= count) break;
  }
  return out;
}

const BRAVE_API = 'https://api.search.brave.com/res/v1/web/search';
const TAVILY_API = 'https://api.tavily.com/search';

export async function searchBrave(key: string, query: string, count: number, signal: AbortSignal, endpoint = BRAVE_API): Promise<SearchResult[]> {
  const url = `${endpoint}?q=${encodeURIComponent(query)}&count=${String(count)}`;
  const body = await requestJson<{ web?: { results?: Array<{ title?: string; url?: string; description?: string }> } }>({
    url,
    headers: { accept: 'application/json', 'x-subscription-token': key },
    signal,
    timeoutMs: TIMEOUT
  });
  return (body.web?.results ?? []).map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.description ?? '' }));
}

export async function searchTavily(key: string, query: string, count: number, signal: AbortSignal, endpoint = TAVILY_API): Promise<SearchResult[]> {
  const body = await requestJson<{ results?: Array<{ title?: string; url?: string; content?: string }> }>({
    url: endpoint,
    headers: { authorization: `Bearer ${key}` },
    body: { query, max_results: count, search_depth: 'basic', include_answer: false },
    signal,
    timeoutMs: TIMEOUT
  });
  return (body.results ?? []).map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.content ?? '' }));
}

async function searchSearxng(base: string, query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const body = await requestJson<{ results?: Array<{ title?: string; url?: string; content?: string }> }>({
    url: `${joinUrl(base, 'search')}?q=${encodeURIComponent(query)}&format=json`,
    headers: { accept: 'application/json' },
    signal,
    timeoutMs: TIMEOUT
  });
  return (body.results ?? []).map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.content ?? '' }));
}

const OPENROUTER_PROMPT =
  'Web search results are attached. List every result, one per line, as "- [page title](url): one sentence on what it says". Add nothing else.';

async function searchOpenRouter(access: OpenRouterAccess, query: string, count: number, noTraining: boolean, signal: AbortSignal): Promise<SearchResult[]> {
  const body = await requestJson<{
    choices?: Array<{ message?: { content?: string | null; annotations?: Array<{ type?: string; url_citation?: { url?: string; title?: string; content?: string } }> } }>;
  }>({
    url: joinUrl(access.baseUrl, 'chat/completions'),
    headers: { authorization: `Bearer ${access.apiKey}`, 'x-title': 'Graft' },
    body: {
      model: access.model,
      messages: [
        { role: 'system', content: OPENROUTER_PROMPT },
        { role: 'user', content: query }
      ],
      plugins: [{ id: 'web', max_results: count }],
      max_tokens: 900,
      stream: false,
      ...(noTraining ? { provider: { data_collection: 'deny' } } : {})
    },
    signal,
    timeoutMs: TIMEOUT
  });
  const message = body.choices?.[0]?.message;
  const cited = (message?.annotations ?? [])
    .filter((a) => a.type === 'url_citation' && a.url_citation)
    .map((a) => ({ title: a.url_citation?.title ?? '', url: a.url_citation?.url ?? '', snippet: a.url_citation?.content ?? '' }));
  // The reply lists the results as Markdown links too, which covers results the citations miss.
  const listed: SearchResult[] = [];
  for (const line of (message?.content ?? '').split('\n')) {
    const match = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\s*:?\s*(.*)$/.exec(line);
    if (match) listed.push({ title: match[1] ?? '', url: match[2] ?? '', snippet: match[3] ?? '' });
  }
  const byUrl = new Map<string, SearchResult>();
  for (const r of [...cited, ...listed]) {
    const existing = byUrl.get(r.url);
    if (!existing) byUrl.set(r.url, r);
    else if (!existing.snippet && r.snippet) existing.snippet = r.snippet;
  }
  return [...byUrl.values()];
}

export class SearchService {
  constructor(private readonly deps: SearchDeps) {}

  /** The engine searches would use now, without contacting anything. */
  active(): SearchEngineId | null {
    const { engine, searxngUrl } = this.deps.settings();
    const ready = (id: SearchEngineId): boolean => {
      switch (id) {
        case 'openrouter':
          return this.deps.hasOpenRouter();
        case 'brave':
        case 'tavily':
          return this.deps.keys.has(searchKeyId(id));
        case 'searxng':
          return searxngUrl !== null;
      }
    };
    if (engine === 'off') return null;
    if (engine !== 'auto') return ready(engine) ? engine : null;
    // Automatic: a search key the user added wins over spending OpenRouter credits.
    return (['brave', 'tavily', 'searxng', 'openrouter'] as const).find(ready) ?? null;
  }

  async search(query: string, count: number, signal: AbortSignal): Promise<{ engine: SearchEngineId; results: SearchResult[] }> {
    const engine = this.active();
    if (!engine) throw new ProviderError('bad_request', 'No web search engine is set up. Add one in Settings → Web search.', { retryable: false });
    let results: SearchResult[];
    switch (engine) {
      case 'brave':
      case 'tavily': {
        const key = this.deps.keys.get(searchKeyId(engine));
        if (!key) throw new ProviderError('auth', `Add your ${SEARCH_ENGINE_LABELS[engine]} key in Settings → Web search.`, { retryable: false });
        results = engine === 'brave' ? await searchBrave(key, query, count, signal) : await searchTavily(key, query, count, signal);
        break;
      }
      case 'searxng':
        results = await searchSearxng(this.deps.settings().searxngUrl ?? '', query, signal);
        break;
      case 'openrouter': {
        const access = await this.deps.openRouter(signal);
        if (!access) throw new ProviderError('auth', 'Add an OpenRouter key to search with OpenRouter.', { retryable: false });
        results = await searchOpenRouter(access, query, count, this.deps.noTraining(), signal);
        break;
      }
    }
    return { engine, results: tidyResults(results, count) };
  }
}
