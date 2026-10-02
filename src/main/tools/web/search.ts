import type { SearchEngineId, SearchEngineSetting } from '@shared/schemas/appSettings';
import type { ModelInfo } from '@shared/schemas/models';
import { ProviderError } from '../../providers/errors';
import { joinUrl, request, requestJson } from '../../providers/http';

/**
 * Web search for the WebSearch tool, behind one interface. Engines:
 * - exa / duckduckgo: free, with no key or account. Exa's hosted search
 *   (rate-limited) and DuckDuckGo's plain-HTML results; each stands in for
 *   the other when it fails. Automatic uses them unless the user set up a
 *   search service.
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

/** Engines that need no key or setup. */
export const FREE_ENGINES = ['exa', 'duckduckgo'] as const;
export type FreeEngine = (typeof FREE_ENGINES)[number];

export const SEARCH_ENGINE_LABELS: Record<SearchEngineId, string> = {
  exa: 'Exa',
  duckduckgo: 'DuckDuckGo',
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

function isFreeEngine(id: SearchEngineId): id is FreeEngine {
  return (FREE_ENGINES as readonly string[]).includes(id);
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
  /** Where the free engines answer; tests point them at local servers. */
  endpoints?: Partial<Record<FreeEngine, string>>;
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

// ---- free engines (no key) ---------------------------------------------------------

const EXA_MCP = 'https://mcp.exa.ai/mcp';
const DUCKDUCKGO_HTML = 'https://html.duckduckgo.com/html/';
/** Names Graft honestly; DuckDuckGo serves its plain-HTML results to such clients. */
const USER_AGENT = 'Mozilla/5.0 (compatible; Graft; +https://github.com/itzdexy/GraftCode)';

/** Exa's highlights are Markdown (tables, headings, reference marks); keep the words. */
function plainText(markdown: string): string {
  return markdown
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\*\*|`|\|/g, ' ')
    .replace(/\[\d+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Exa's results as text: "Title:", "URL:" and other header lines, then highlights, with "---" lines between results. */
export function parseExa(text: string): SearchResult[] {
  return text.split(/\n-{3,}[ \t]*\n/).flatMap((block) => {
    const url = /^URL:\s*(\S+)/m.exec(block)?.[1];
    if (!url) return [];
    const body = /^(?:Highlights|Summary|Text):/m.exec(block);
    return [{ title: /^Title:[ \t]*(.*)$/m.exec(block)?.[1] ?? '', url, snippet: body ? plainText(block.slice(body.index + body[0].length)) : '' }];
  });
}

type McpReply = { result?: { content?: Array<{ type?: string; text?: unknown }>; isError?: boolean }; error?: { message?: string } };

/** The JSON-RPC reply in an MCP response: plain JSON, or the server-sent event that carries it. */
function mcpReply(body: string): McpReply | null {
  const trimmed = body.trim();
  const candidates = trimmed.startsWith('{') ? [trimmed] : trimmed.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
  for (const candidate of candidates) {
    try {
      const reply = JSON.parse(candidate) as McpReply;
      if (reply.result || reply.error) return reply;
    } catch {
      // Not JSON: keep looking.
    }
  }
  return null;
}

/** Exa's hosted search: free without a key (rate-limited). It speaks MCP over HTTP. */
export async function searchExa(query: string, count: number, signal: AbortSignal, endpoint = EXA_MCP): Promise<SearchResult[]> {
  const response = await request({
    url: endpoint,
    headers: { accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search_exa', arguments: { query, numResults: count } } },
    signal,
    timeoutMs: TIMEOUT
  });
  const reply = mcpReply(await response.text());
  if (!reply) throw new ProviderError('bad_request', 'Exa answered in a form Graft could not read.', { retryable: false });
  const text = (reply.result?.content ?? []).flatMap((c) => (c.type === 'text' && typeof c.text === 'string' ? [c.text] : [])).join('\n---\n');
  if (reply.error || reply.result?.isError) {
    throw new ProviderError('bad_request', `Exa search failed: ${(reply.error?.message ?? text).slice(0, 200) || 'no reason given'}`, { retryable: false });
  }
  return parseExa(text);
}

function decodeEntities(text: string): string {
  const char = (code: number): string => (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '');
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => char(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => char(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function htmlText(html: string | undefined): string {
  return decodeEntities((html ?? '').replace(/<[^>]+>/g, ''));
}

/** A result link, unwrapped when DuckDuckGo routes it through //duckduckgo.com/l/?uddg=<address>; its own pages are skipped. */
function resultUrl(href: string): string | null {
  try {
    const url = new URL(decodeEntities(href), 'https://duckduckgo.com');
    if (!/(^|\.)duckduckgo\.com$/.test(url.hostname)) return url.href;
    return url.pathname === '/l/' ? url.searchParams.get('uddg') : null;
  } catch {
    return null;
  }
}

/** Results from DuckDuckGo's plain-HTML page, without its ads. */
export function parseDuckDuckGo(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const block of html.split(/<div class="result\b/).slice(1)) {
    if (/^[^>]*result--ad/.test(block)) continue;
    const link = /<a\b[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(block) ?? /<a\b[^>]*href="([^"]*)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    const url = link ? resultUrl(link[1] ?? '') : null;
    if (!link || !url) continue;
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(block)?.[1];
    results.push({ title: htmlText(link[2]), url, snippet: htmlText(snippet) });
  }
  return results;
}

/** DuckDuckGo's plain-HTML search: free, no key, no tracking. */
export async function searchDuckDuckGo(query: string, count: number, signal: AbortSignal, endpoint = DUCKDUCKGO_HTML): Promise<SearchResult[]> {
  const response = await request({
    url: endpoint,
    method: 'POST',
    headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
    body: new URLSearchParams({ q: query }).toString(),
    signal,
    timeoutMs: TIMEOUT
  });
  const html = await response.text();
  const results = parseDuckDuckGo(html);
  if (results.length === 0 && html.includes('anomaly-modal')) {
    throw new ProviderError('rate_limit', 'DuckDuckGo wants a human check right now. Try again in a little while.', { retryable: false });
  }
  return results.slice(0, count);
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
      if (isFreeEngine(id)) return true;
      if (isProviderEngine(id)) return providers.includes(id);
      if (id === 'searxng') return searxngUrl !== null;
      return this.deps.keys.has(searchKeyId(id));
    };
    if (engine === 'off') return null;
    if (engine !== 'auto') return ready(engine) ? engine : null;
    // Automatic: a search service the user set up wins, else the free engines. A provider's paid search runs only when picked.
    return (['brave', 'tavily', 'searxng'] as const).find(ready) ?? 'exa';
  }

  /** A free engine, then the other one when it fails or finds nothing. */
  private async free(first: FreeEngine, query: string, count: number, signal: AbortSignal): Promise<{ engine: SearchEngineId; results: SearchResult[] }> {
    let failure: Error | null = null;
    for (const engine of first === 'exa' ? (['exa', 'duckduckgo'] as const) : (['duckduckgo', 'exa'] as const)) {
      try {
        const endpoint = this.deps.endpoints?.[engine];
        const found = engine === 'exa' ? await searchExa(query, count, signal, endpoint) : await searchDuckDuckGo(query, count, signal, endpoint);
        const results = tidyResults(found, count);
        if (results.length > 0) return { engine, results };
      } catch (error) {
        if (signal.aborted) throw error;
        failure = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (failure) throw failure;
    return { engine: first, results: [] };
  }

  async search(query: string, count: number, signal: AbortSignal): Promise<{ engine: SearchEngineId; results: SearchResult[] }> {
    const engine = this.active();
    if (!engine) {
      const chosen = this.deps.settings().engine;
      throw new ProviderError(
        'bad_request',
        chosen === 'off' || chosen === 'auto'
          ? 'Web search is off. Turn it on in Settings → Web search.'
          : `${SEARCH_ENGINE_LABELS[chosen]} isn't set up yet. Finish it in Settings → Web search, or pick Automatic for free search.`,
        { retryable: false }
      );
    }
    if (isFreeEngine(engine)) return this.free(engine, query, count, signal);
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
