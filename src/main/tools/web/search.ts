import type { SearchEngineId, SearchEngineSetting } from '@shared/schemas/appSettings';
import type { ModelInfo } from '@shared/schemas/models';
import { ProviderError } from '../../providers/errors';
import { joinUrl, requestJson } from '../../providers/http';

/**
 * Web search for the WebSearch tool, behind one interface. Engines:
 * - openrouter / anthropic / openai / gemini: one small request to that
 *   provider's own web search (OpenRouter's web plugin, Anthropic's
 *   web_search tool, OpenAI's Responses web_search, Gemini's Google Search
 *   grounding), with the user's key and a low-cost model of that provider.
 * - brave / tavily: their search APIs with the user's own key.
 * - searxng: a SearXNG instance's JSON API (often self-hosted).
 * Results are untrusted web content; callers must never follow instructions in them.
 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Site to show when the URL is a redirect (Gemini returns Google redirect links). */
  site?: string;
}

export type { SearchEngineId } from '@shared/schemas/appSettings';

/** Engines that are a model provider's own search. */
export const PROVIDER_ENGINES = ['openrouter', 'anthropic', 'openai', 'gemini'] as const;
export type ProviderEngine = (typeof PROVIDER_ENGINES)[number];

export const SEARCH_ENGINE_LABELS: Record<SearchEngineId, string> = {
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  brave: 'Brave Search',
  tavily: 'Tavily',
  searxng: 'SearXNG'
};

function isProviderEngine(id: SearchEngineId): id is ProviderEngine {
  return (PROVIDER_ENGINES as readonly string[]).includes(id);
}

/** KeyStore id of a search engine's API key. */
export function searchKeyId(engine: 'brave' | 'tavily'): string {
  return `search:${engine}`;
}

export interface ProviderAccess {
  /** The provider's base URL when the user set one; null for the vendor default. */
  baseUrl: string | null;
  apiKey: string;
  /** Low-cost model of that provider that runs the search. */
  model: string;
}

/** Models able to run each provider's search; older or special-purpose models can't. */
const SEARCH_MODELS: Record<ProviderEngine, { include?: RegExp; exclude?: RegExp }> = {
  openrouter: { exclude: /:free$/ },
  anthropic: { exclude: /^claude-(instant|2|3-(opus|sonnet|haiku))/ },
  openai: { include: /^(gpt-5|gpt-4\.1|gpt-4o|o3|o4)/, exclude: /(nano|audio|realtime|transcribe|tts|search|image|codex|chat-latest|deep-research)/ },
  gemini: { include: /^gemini-/, exclude: /(image|tts|embedding|live|audio|robotics)/ }
};

/** Cheapest priced model that can search and has room for the results; free models often log prompts. */
export function searchReaderModel(engine: ProviderEngine, models: ModelInfo[]): string | null {
  const rule = SEARCH_MODELS[engine];
  const usable = models.filter((m) => (!rule.include || rule.include.test(m.ref.modelId)) && !rule.exclude?.test(m.ref.modelId) && m.contextWindow >= 16_000);
  const cost = (m: ModelInfo): number => (m.pricing ? m.pricing.input + m.pricing.output : Number.POSITIVE_INFINITY);
  const priced = usable.filter((m) => m.pricing !== null && m.pricing.input > 0).sort((a, b) => cost(a) - cost(b));
  return (priced[0] ?? usable[0])?.ref.modelId ?? null;
}

export interface SearchDeps {
  settings(): { engine: SearchEngineSetting; searxngUrl: string | null };
  /** Settings → Privacy: keep OpenRouter away from providers that train on prompts. */
  noTraining(): boolean;
  keys: { get(id: string): string | null; has(id: string): boolean };
  /** Providers with a key whose search can be used, the default model's provider first (no network). */
  providers(): ProviderEngine[];
  access(engine: ProviderEngine, signal?: AbortSignal): Promise<ProviderAccess | null>;
}

const TIMEOUT = 45_000;
const ASK = (query: string): string => `Search the web for: ${query}\nList the most relevant pages you found.`;

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
    const site = r.site && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(r.site) ? r.site.toLowerCase() : undefined;
    out.push({ title: clean(r.title, 200) || site || new URL(r.url).hostname, url: r.url, snippet: clean(r.snippet), ...(site ? { site } : {}) });
    if (out.length >= count) break;
  }
  return out;
}

/** Joins results seen twice (e.g. a listed result that is also cited), keeping the first title and any snippet. */
function mergeByUrl(results: SearchResult[]): SearchResult[] {
  const byUrl = new Map<string, SearchResult>();
  for (const r of results) {
    const existing = byUrl.get(r.url);
    if (!existing) byUrl.set(r.url, { ...r });
    else {
      if (!existing.snippet && r.snippet) existing.snippet = r.snippet;
      if (!existing.title && r.title) existing.title = r.title;
    }
  }
  return [...byUrl.values()];
}

// ---- search APIs ----------------------------------------------------------------

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

// ---- providers' own search ---------------------------------------------------------

const OPENROUTER_PROMPT =
  'Web search results are attached. List every result, one per line, as "- [page title](url): one sentence on what it says". Add nothing else.';

export async function searchOpenRouter(access: ProviderAccess, query: string, count: number, noTraining: boolean, signal: AbortSignal): Promise<SearchResult[]> {
  const body = await requestJson<{
    choices?: Array<{ message?: { content?: string | null; annotations?: Array<{ type?: string; url_citation?: { url?: string; title?: string; content?: string } }> } }>;
  }>({
    url: joinUrl(access.baseUrl ?? 'https://openrouter.ai/api/v1', 'chat/completions'),
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
  return mergeByUrl([...cited, ...listed]);
}

export async function searchAnthropic(access: ProviderAccess, query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const base = access.baseUrl ?? 'https://api.anthropic.com';
  const body = await requestJson<{
    content?: Array<{
      type?: string;
      content?: Array<{ type?: string; url?: string; title?: string }> | { type?: string; error_code?: string };
      citations?: Array<{ type?: string; url?: string; title?: string; cited_text?: string }>;
    }>;
  }>({
    url: joinUrl(base, /\/v1\/?$/.test(base) ? 'messages' : 'v1/messages'),
    headers: { 'x-api-key': access.apiKey, 'anthropic-version': '2023-06-01' },
    body: {
      model: access.model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: ASK(query) }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }]
    },
    signal,
    timeoutMs: TIMEOUT
  });
  const found: SearchResult[] = [];
  for (const block of body.content ?? []) {
    if (block.type === 'web_search_tool_result') {
      if (!Array.isArray(block.content)) {
        throw new ProviderError('bad_request', `Anthropic web search failed (${block.content?.error_code ?? 'unknown error'}).`, { retryable: false });
      }
      for (const r of block.content) if (r.type === 'web_search_result') found.push({ title: r.title ?? '', url: r.url ?? '', snippet: '' });
    }
    for (const c of block.citations ?? []) {
      if (c.type === 'web_search_result_location') found.push({ title: c.title ?? '', url: c.url ?? '', snippet: c.cited_text ?? '' });
    }
  }
  return mergeByUrl(found);
}

export async function searchOpenAI(access: ProviderAccess, query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const body = await requestJson<{
    output?: Array<{
      type?: string;
      action?: { sources?: Array<{ type?: string; url?: string }> };
      content?: Array<{ type?: string; text?: string; annotations?: Array<{ type?: string; url?: string; title?: string; start_index?: number; end_index?: number }> }>;
    }>;
  }>({
    url: joinUrl(access.baseUrl ?? 'https://api.openai.com/v1', 'responses'),
    headers: { authorization: `Bearer ${access.apiKey}` },
    body: {
      model: access.model,
      input: ASK(query),
      tools: [{ type: 'web_search' }],
      include: ['web_search_call.action.sources'],
      max_output_tokens: 1200,
      store: false
    },
    signal,
    timeoutMs: TIMEOUT
  });
  const cited: SearchResult[] = [];
  const sources: SearchResult[] = [];
  for (const item of body.output ?? []) {
    for (const s of item.action?.sources ?? []) if (s.url) sources.push({ title: '', url: s.url, snippet: '' });
    for (const part of item.content ?? []) {
      for (const a of part.annotations ?? []) {
        if (a.type !== 'url_citation' || !a.url) continue;
        // The sentence the citation supports reads as the snippet.
        const text = part.text ?? '';
        const before = text.slice(0, a.start_index ?? 0);
        const sentence = before.slice(Math.max(before.lastIndexOf('. '), before.lastIndexOf('\n')) + 1).trim();
        cited.push({ title: a.title ?? '', url: a.url, snippet: sentence });
      }
    }
  }
  return mergeByUrl([...cited, ...sources]);
}

export async function searchGemini(access: ProviderAccess, query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const body = await requestJson<{
    candidates?: Array<{
      groundingMetadata?: {
        groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
        groundingSupports?: Array<{ segment?: { text?: string }; groundingChunkIndices?: number[] }>;
      };
    }>;
  }>({
    url: joinUrl(access.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta', `models/${encodeURIComponent(access.model)}:generateContent`),
    headers: { 'x-goog-api-key': access.apiKey },
    body: { contents: [{ role: 'user', parts: [{ text: ASK(query) }] }], tools: [{ google_search: {} }] },
    signal,
    timeoutMs: TIMEOUT
  });
  const grounding = body.candidates?.[0]?.groundingMetadata;
  const chunks = grounding?.groundingChunks ?? [];
  const snippets = new Map<number, string>();
  for (const support of grounding?.groundingSupports ?? []) {
    for (const i of support.groundingChunkIndices ?? []) if (!snippets.has(i) && support.segment?.text) snippets.set(i, support.segment.text);
  }
  // Links are Google redirects; the chunk title is the site they lead to.
  return chunks.flatMap((c, i) => (c.web?.uri ? [{ title: c.web.title ?? '', url: c.web.uri, snippet: snippets.get(i) ?? '', site: c.web.title ?? '' }] : []));
}

export class SearchService {
  constructor(private readonly deps: SearchDeps) {}

  /** Providers whose own search can be used now. */
  providers(): ProviderEngine[] {
    return this.deps.providers();
  }

  /** The engine searches would use now, without contacting anything. */
  active(): SearchEngineId | null {
    const { engine, searxngUrl } = this.deps.settings();
    const providers = this.deps.providers();
    const ready = (id: SearchEngineId): boolean => {
      if (isProviderEngine(id)) return providers.includes(id);
      if (id === 'searxng') return searxngUrl !== null;
      return this.deps.keys.has(searchKeyId(id));
    };
    if (engine === 'off') return null;
    if (engine !== 'auto') return ready(engine) ? engine : null;
    // Automatic: an engine the user set up for search wins, then the default model's provider.
    return (['brave', 'tavily', 'searxng'] as const).find(ready) ?? providers[0] ?? null;
  }

  async search(query: string, count: number, signal: AbortSignal): Promise<{ engine: SearchEngineId; results: SearchResult[] }> {
    const engine = this.active();
    if (!engine) throw new ProviderError('bad_request', 'No web search engine is set up. Add one in Settings → Web search.', { retryable: false });
    let results: SearchResult[];
    if (isProviderEngine(engine)) {
      const access = await this.deps.access(engine, signal);
      if (!access) throw new ProviderError('auth', `Add an ${SEARCH_ENGINE_LABELS[engine]} key to search with ${SEARCH_ENGINE_LABELS[engine]}.`, { retryable: false });
      switch (engine) {
        case 'openrouter':
          results = await searchOpenRouter(access, query, count, this.deps.noTraining(), signal);
          break;
        case 'anthropic':
          results = await searchAnthropic(access, query, signal);
          break;
        case 'openai':
          results = await searchOpenAI(access, query, signal);
          break;
        case 'gemini':
          results = await searchGemini(access, query, signal);
          break;
      }
    } else if (engine === 'searxng') {
      results = await searchSearxng(this.deps.settings().searxngUrl ?? '', query, signal);
    } else {
      const key = this.deps.keys.get(searchKeyId(engine));
      if (!key) throw new ProviderError('auth', `Add your ${SEARCH_ENGINE_LABELS[engine]} key in Settings → Web search.`, { retryable: false });
      results = engine === 'brave' ? await searchBrave(key, query, count, signal) : await searchTavily(key, query, count, signal);
    }
    return { engine, results: tidyResults(results, count) };
  }
}
