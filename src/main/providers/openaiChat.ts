import { randomUUID } from 'node:crypto';
import type { ProviderKind, Usage } from '@shared/schemas/common';
import type { ContentBlock, LlmMessage } from '@shared/schemas/messages';
import type { CustomModel, ModelInfo } from '@shared/schemas/models';
import { isLocalUrl } from '@shared/privacy';
import { arrangeModels, describeCapabilities, familyOf, isFastTier, labelFromId } from './catalog';
import { ProviderError } from './errors';
import { hostOf, joinUrl, request, requestJson } from './http';
import { onlyInResponses, readResponsesStream, responsesBody, usesResponses } from './openaiResponses';
import { catalogEffort, modelPricing, NATIVE_PRESET, type CatalogModel, type ProviderCatalog } from './presets';
import { parseSse } from './sse';
import { isOfficialOpenAiModels, openAiShutdownDate, withModelLifecycle } from './modelLifecycle';
import type { FinishReason, LLMProvider, ProviderConnection, RequestPrivacy, StreamEvent, StreamRequest } from './types';

type ChatKind = Extract<ProviderKind, 'openai' | 'openrouter' | 'openai-compatible'>;

const DEFAULT_BASE: Record<ChatKind, string | null> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  'openai-compatible': null
};

/** Model ids on the OpenAI list endpoint that neither chat completions nor the Responses API serve as chat. */
const NON_CHAT = /(embed|whisper|tts|dall-e|davinci|babbage|moderation|audio|realtime|transcribe|image|search|computer-use|sora)/i;
/** Non-chat models other OpenAI-compatible servers commonly list next to chat models. */
const NON_CHAT_LIGHT = /(embed|whisper|tts|dall-e|moderation|rerank|transcri|text-to-speech|stable-diffusion|sdxl|flux)/i;
/**
 * OpenRouter models that only cache prompts at an explicit breakpoint. The
 * top-level cache_control puts one on the last cacheable block, so each step of
 * a tool loop reads the prefix the previous step wrote.
 */
const BREAKPOINT_CACHING = /^~?anthropic\//;

/**
 * Size hints for OpenAI models the catalog doesn't know, keyed by id prefix;
 * the first match wins. Other providers report limits or come from the catalog.
 */
const OPENAI_LIMITS: Array<{ prefix: RegExp; context: number; output: number; reasoning: boolean; vision: boolean }> = [
  { prefix: /^gpt-5/, context: 400_000, output: 128_000, reasoning: true, vision: true },
  { prefix: /^o\d/, context: 200_000, output: 100_000, reasoning: true, vision: true },
  { prefix: /^gpt-4\.1/, context: 1_047_576, output: 32_768, reasoning: false, vision: true },
  { prefix: /^(gpt-4o|chatgpt-4o)/, context: 128_000, output: 16_384, reasoning: false, vision: true },
  { prefix: /^gpt-4/, context: 128_000, output: 8_192, reasoning: false, vision: false },
  { prefix: /^gpt-3\.5/, context: 16_385, output: 4_096, reasoning: false, vision: false }
];

/**
 * Where servers that speak this API say how large a model's context is and how
 * long a reply may be. There is no standard name for either, so each is a path
 * into the model's entry in the list; the first that holds a believable count
 * wins.
 */
const CONTEXT_PATHS = [
  ['context_length'],
  ['context_window'],
  ['max_context_length'],
  ['context_size'],
  ['max_model_len'],
  ['max_input_tokens'],
  ['input_token_limit'],
  ['n_ctx'],
  ['top_provider', 'context_length'],
  ['metadata', 'context_length'],
  ['meta', 'n_ctx_train'],
  ['limits', 'max_input_tokens'],
  ['capabilities', 'limits', 'max_context_window_tokens'],
  ['model_spec', 'availableContextTokens'],
  ['model_info', 'max_input_tokens']
];
const OUTPUT_PATHS = [
  ['max_completion_tokens'],
  ['max_output_tokens'],
  ['max_output_length'],
  ['top_provider', 'max_completion_tokens'],
  ['metadata', 'max_tokens'],
  ['limits', 'max_output_tokens'],
  ['capabilities', 'limits', 'max_output_tokens'],
  ['model_info', 'max_output_tokens']
];

/**
 * How large a model's context is, from the best source that says: the server
 * itself (its figure is about this server), then its provider's catalog entry,
 * then, for a hosted model, what most providers give for a model of that name.
 * A server on this computer runs with the window it was started with, whatever
 * the model could hold elsewhere, and some cut a long prompt short without a
 * word, so a name is not trusted there.
 *
 * When nothing says, the size is assumed: nine in ten hosted models in the
 * catalog have 128,000 tokens or more, and a local server often has far less.
 * Too large a guess is corrected the first time a request is refused as too
 * long; too small a one summarizes the conversation early, on every turn.
 */
export function contextSize(sources: { reported: number | null; listed: number | null; typical: number | null; local: boolean }): { tokens: number; assumed: boolean } {
  const known = sources.reported ?? sources.listed ?? (sources.local ? null : sources.typical);
  return known !== null ? { tokens: known, assumed: false } : { tokens: sources.local ? 32_768 : 128_000, assumed: true };
}

/**
 * The reply budget to try again with when a server refuses the one it was
 * sent. What the catalog says a model can write is not always what a given
 * server allows, and some servers count the reply against the context window.
 * Gives the room the refusal leaves (the window minus the prompt, or the most
 * the server says it allows), a modest budget when it names no figure, and
 * null when the refusal is not about the reply budget or a smaller one would
 * not help: a prompt that is itself too long has to be summarized instead.
 */
export function smallerReplyBudget(message: string, sent: number): number | null {
  if (!/max_(completion_|new_|output_)?tokens|in the completion|completion tokens/i.test(message)) return null;
  const window = Number(/(?:context (?:length|window|size)(?: is| of|:)?|must be <=)\s*(\d+)/i.exec(message)?.[1]);
  const prompt = Number(/(\d+)\s*(?:in the messages|`?inputs?`? tokens|input tokens|prompt tokens)/i.exec(message)?.[1]);
  if (Number.isFinite(window) && Number.isFinite(prompt)) {
    const room = window - prompt - 64;
    return room >= 256 && room < sent ? room : null;
  }
  // The largest figure below the one sent is the most the server allows ("at most 8192", "the range is [1, 8192]").
  const allowed = Math.max(0, ...(message.match(/\d+/g) ?? []).map(Number).filter((n) => n >= 256 && n < sent));
  if (allowed > 0) return allowed;
  return sent > 8192 ? 8192 : null;
}

/** The token count at the first of the paths that holds one (a number, or digits as text) no smaller than `least`. */
function reported(model: unknown, paths: string[][], least: number): number | null {
  for (const keys of paths) {
    let value: unknown = model;
    for (const key of keys) value = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
    const count = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (typeof count === 'number' && Number.isInteger(count) && count >= least && count <= 10_000_000) return count;
  }
  return null;
}

interface OpenAiModel {
  id: string;
  shutdown_date?: unknown;
  created?: number;
  name?: string;
  description?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[] };
  supported_parameters?: string[];
  top_provider?: { max_completion_tokens?: number | null };
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
}

type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ChatContentPart[] }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
      reasoning_details?: unknown[];
      reasoning_content?: string;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Reasoning saved with an assistant message so it can be sent back during a tool loop. */
interface ReasoningReplay {
  model: string;
  reasoning_details?: unknown[];
  reasoning_content?: string;
}

function replayOf(block: ContentBlock, kind: ProviderKind, model: string): ReasoningReplay | null {
  if (block.type !== 'provider' || block.provider !== kind) return null;
  const raw = block.raw as Partial<ReasoningReplay> | null;
  return raw && raw.model === model ? (raw as ReasoningReplay) : null;
}

/** A user message the person typed (not only tool results): it starts a new turn. */
function startsTurn(message: LlmMessage): boolean {
  return message.role === 'user' && message.content.some((b) => b.type !== 'tool_result');
}

/**
 * Converts neutral history into chat-completions messages (tool results become
 * role "tool"). With `replay`, reasoning saved from the same provider and model
 * goes back on assistant messages: `reasoning_details` always (OpenRouter keeps
 * reasoning valid across tool calls that way), `reasoning_content` only within
 * the current turn's tool loop, as interleaved-thinking APIs expect.
 */
export function toChatMessages(system: string, messages: LlmMessage[], vision: boolean, replay?: { kind: ProviderKind; model: string }): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }];
  let lastTurnStart = -1;
  messages.forEach((m, i) => {
    if (startsTurn(m)) lastTurnStart = i;
  });
  messages.forEach((message, index) => {
    if (message.role === 'assistant') {
      const text = message.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const calls = message.content
        .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function' as const,
          function: { name: b.name, arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}) }
        }));
      if (text.length === 0 && calls.length === 0) return;
      const saved = replay ? message.content.map((b) => replayOf(b, replay.kind, replay.model)).find((r) => r !== null) : null;
      out.push({
        role: 'assistant',
        content: text.length > 0 ? text : null,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
        ...(saved?.reasoning_details ? { reasoning_details: saved.reasoning_details } : {}),
        ...(saved?.reasoning_content && index > lastTurnStart ? { reasoning_content: saved.reasoning_content } : {})
      });
      return;
    }
    const parts: ChatContentPart[] = [];
    const toolImages: ChatContentPart[] = [];
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        const text = block.content
          .filter((c) => c.type === 'text')
          .map((c) => (c.type === 'text' ? c.text : ''))
          .join('\n');
        out.push({ role: 'tool', tool_call_id: block.toolUseId, content: (block.isError ? 'Error: ' : '') + (text || '(no output)') });
        for (const c of block.content) {
          if (c.type === 'image' && vision) toolImages.push({ type: 'image_url', image_url: { url: `data:${c.mediaType};base64,${c.data}` } });
        }
      } else if (block.type === 'text' && block.text.length > 0) {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        parts.push(
          vision
            ? { type: 'image_url', image_url: { url: `data:${block.mediaType};base64,${block.data}` } }
            : { type: 'text', text: '[An image was attached, but this model cannot view images.]' }
        );
      }
    }
    if (toolImages.length > 0) parts.unshift({ type: 'text', text: 'Images returned by the tool calls above:' }, ...toolImages);
    if (parts.length === 0) return;
    const onlyText = parts.every((p) => p.type === 'text');
    out.push({ role: 'user', content: onlyText ? parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n\n') : parts });
  });
  return out;
}

/** Appends a streamed `reasoning_details` fragment to the details collected so far. */
export function mergeReasoningDetail(details: Array<Record<string, unknown>>, fragment: unknown): void {
  if (!fragment || typeof fragment !== 'object') return;
  const part = fragment as Record<string, unknown>;
  const index = typeof part.index === 'number' && part.index >= 0 ? part.index : details.length;
  const existing = details[index];
  if (!existing) {
    details[index] = { ...part };
    return;
  }
  for (const [key, value] of Object.entries(part)) {
    if ((key === 'text' || key === 'summary' || key === 'data') && typeof value === 'string' && typeof existing[key] === 'string') {
      existing[key] = existing[key] + value;
    } else if (value !== null && value !== undefined) {
      existing[key] = value;
    }
  }
}

function mapFinish(reason: string | null): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return reason ? 'other' : 'stop';
  }
}

function perMillion(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : null;
}

export class OpenAiChatProvider implements LLMProvider {
  readonly id: string;
  readonly kind: ChatKind;
  private readonly base: string;
  private readonly apiKey: string | null;
  private readonly customModels: CustomModel[];
  private readonly catalog: ProviderCatalog | null;
  /** Catalog entries used for model metadata: the connection's own preset, else the ones that answer at its address. */
  private readonly presetIds: string[];
  private readonly noStreamOptions = new Set<string>();
  private readonly noReasoningParam = new Set<string>();
  /** The reply budget a server turned out to allow for a model, when it refused the catalog's. */
  private readonly replyBudget = new Map<string, number>();
  /** OpenAI models that answered "only supported in v1/responses"; they go there first from then on. */
  private readonly responsesOnly = new Set<string>();

  constructor(connection: ProviderConnection & { kind: ChatKind }, customModels: CustomModel[] = [], catalog: ProviderCatalog | null = null) {
    this.id = connection.id;
    this.kind = connection.kind;
    const base = connection.baseUrl ?? DEFAULT_BASE[connection.kind];
    if (!base) throw new ProviderError('bad_base_url', 'A base URL is required for a custom endpoint.', { retryable: false });
    const placeholder = /\$\{([^}]+)\}/.exec(base);
    if (placeholder) {
      throw new ProviderError('bad_base_url', `Replace \${${placeholder[1] ?? ''}} in the base URL with your own value.`, { retryable: false });
    }
    this.base = base;
    this.apiKey = connection.apiKey;
    this.customModels = customModels;
    this.catalog = catalog;
    const named = connection.preset ?? NATIVE_PRESET[connection.kind] ?? null;
    this.presetIds = named ? [named] : (catalog?.presetsForUrl(base) ?? []);
    if (this.kind !== 'openai-compatible' && !this.apiKey) {
      throw new ProviderError('auth', 'An API key is required.', { retryable: false });
    }
  }

  private headers(): Record<string, string> {
    return {
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...(this.kind === 'openrouter' ? { 'x-title': 'Graft' } : {})
    };
  }

  private meta(modelId: string): CatalogModel | null {
    for (const preset of this.presetIds) {
      const found = this.catalog?.model(preset, modelId);
      if (found) return found;
    }
    return null;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const official = isOfficialOpenAiModels(this.base, this.kind);
    // OpenRouter's catalog is public, so confirm the key against an authenticated endpoint first.
    if (this.kind === 'openrouter') {
      await requestJson<unknown>({ url: joinUrl(this.base, 'key'), headers: this.headers(), ...(signal ? { signal } : {}) });
    }
    let listed: OpenAiModel[];
    let catalogFallback = false;
    try {
      const body = await requestJson<{ data?: OpenAiModel[] }>({
        url: joinUrl(this.base, 'models'),
        headers: this.headers(),
        ...(official ? { redirect: 'error' as const } : {}),
        ...(signal ? { signal } : {})
      });
      if (!Array.isArray(body.data)) {
        throw new ProviderError('bad_base_url', `${hostOf(this.base)} did not return a model list — check the base URL.`, { retryable: false });
      }
      listed = body.data.filter((m) => typeof m.id === 'string');
    } catch (error) {
      // Some providers have no list endpoint: confirm the key with a one-token request and offer the catalog's models.
      const preset = this.presetIds[0];
      const known = this.kind === 'openai-compatible' && preset ? (this.catalog?.models(preset) ?? []) : [];
      const listMissing = error instanceof ProviderError && (error.code === 'not_found' || error.code === 'bad_base_url');
      const first = known.find((m) => !m.deprecated) ?? known[0];
      if (!listMissing || !first) throw error;
      await this.ping(first.id, signal);
      catalogFallback = true;
      listed = known.filter((m) => !m.deprecated).map((m) => ({ id: m.id }));
    }
    const models: ModelInfo[] = listed
      .filter((m) => {
        if (this.kind === 'openai') return !NON_CHAT.test(m.id);
        if (this.kind === 'openai-compatible') return this.meta(m.id) !== null || !NON_CHAT_LIGHT.test(m.id);
        return true;
      })
      .map((m): ModelInfo => {
        const lifecycle = official ? openAiShutdownDate(m.shutdown_date) : undefined;
        return withModelLifecycle({ ...this.toModelInfo(m), ...(lifecycle ? { lifecycle } : {}), availability: {
          state: catalogFallback || this.kind === 'openrouter' ? 'cataloged-unverified' as const : 'available' as const,
          source: catalogFallback ? 'catalog' as const : 'provider' as const, checkedAt: Date.now(),
          reason: catalogFallback ? 'Catalog metadata; this provider has no model-list API. Account access to each model is unverified.'
            : this.kind === 'openrouter' ? 'Public provider catalog; the key is valid, but account access to each model is unverified.' : null, selectable: true
        } });
      });
    const ids = new Set(models.map((m) => m.ref.modelId));
    for (const custom of this.customModels) {
      if (!ids.has(custom.id)) models.push({ ...this.toModelInfo({ id: custom.id }), availability: {
        state: 'cataloged-unverified', source: 'custom', checkedAt: null, reason: 'Custom model ID; account access has not been verified.', selectable: true
      } });
    }
    return arrangeModels(models);
  }

  /** Smallest possible chat request, used to verify a key when there is no list endpoint. */
  private async ping(modelId: string, signal?: AbortSignal): Promise<void> {
    const response = await request({
      url: joinUrl(this.base, 'chat/completions'),
      headers: this.headers(),
      body: { model: modelId, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 1, stream: false },
      ...(signal ? { signal } : {}),
      timeoutMs: 60_000
    });
    await response.text().catch(() => '');
  }

  private toModelInfo(m: OpenAiModel): ModelInfo {
    const custom = this.customModels.find((c) => c.id === m.id);
    const meta = this.meta(m.id);
    let known: { context: number | null; output: number | null } = { context: meta?.context ?? null, output: meta?.output ?? null };
    let reasoning = meta?.reasoning ?? false;
    let vision = meta?.vision ?? false;
    let tools = meta?.capabilities.tools ?? true;
    let pricing = modelPricing(meta?.pricing ?? null);
    if (this.kind === 'openai' && !meta) {
      const hint = OPENAI_LIMITS.find((h) => h.prefix.test(m.id)) ?? { context: 128_000, output: 16_384, reasoning, vision: true };
      known = { context: hint.context, output: hint.output };
      ({ reasoning, vision } = hint);
    } else if (this.kind === 'openrouter') {
      const params = m.supported_parameters;
      if (params) {
        reasoning = params.includes('reasoning');
        tools = params.includes('tools');
      }
      if (m.architecture?.input_modalities) vision = m.architecture.input_modalities.includes('image');
      const input = perMillion(m.pricing?.prompt);
      const out = perMillion(m.pricing?.completion);
      if (input !== null && out !== null) {
        const cacheRead = perMillion(m.pricing?.input_cache_read);
        const cacheWrite = perMillion(m.pricing?.input_cache_write);
        pricing = { input, output: out, ...(cacheRead !== null ? { cacheRead } : {}), ...(cacheWrite !== null ? { cacheWrite } : {}) };
      }
    }
    // What a server says about its own model is about this server; the catalog's figure is about the model in general.
    const size = contextSize({
      reported: reported(m, CONTEXT_PATHS, 1024),
      listed: known.context,
      typical: this.catalog?.typicalContext(m.id) ?? null,
      local: isLocalUrl(this.base)
    });
    let context = size.tokens;
    let output = reported(m, OUTPUT_PATHS, 256) ?? known.output ?? (this.kind === 'openrouter' ? Math.min(32_768, Math.floor(context / 4)) : 8_192);
    if (custom) {
      context = custom.contextWindow ?? context;
      output = custom.maxOutputTokens ?? output;
      vision = custom.vision ?? vision;
    }
    // Plain OpenAI-compatible servers only get the levels the catalog says the model accepts.
    const effort = catalogEffort(meta, {
      reasoning,
      fallback: this.kind === 'openai-compatible' ? [] : ['low', 'medium', 'high'],
      allowOff: this.kind !== 'openai-compatible' || (meta?.effortValues?.includes('none') ?? false),
      budgets: this.kind === 'openrouter'
    });
    return {
      ref: { providerId: this.id, modelId: m.id },
      label: custom?.label ?? m.name ?? meta?.name ?? labelFromId(m.id),
      description:
        this.kind === 'openrouter' && m.description
          ? firstSentence(m.description)
          : describeCapabilities({ contextWindow: context, assumed: size.assumed && custom?.contextWindow === undefined, supportsVision: vision, effort, supportsTools: tools }),
      family: meta?.family ?? familyOf(m.id),
      contextWindow: context,
      maxOutputTokens: output,
      supportsTools: tools,
      supportsVision: vision,
      supportsWebSearch: false,
      effort,
      featured: false,
      cheap: isFastTier(m.id),
      createdAt: typeof m.created === 'number' ? m.created * 1000 : (meta?.releasedAt ?? null),
      pricing
    };
  }

  async *streamText(req: StreamRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const modelId = req.model.ref.modelId;
    if (this.kind === 'openai' && (this.responsesOnly.has(modelId) || usesResponses(modelId))) {
      yield* this.streamResponses(req, signal);
      return;
    }
    let maxTokens = Math.min(req.model.maxOutputTokens, 64_000, this.replyBudget.get(modelId) ?? Infinity);
    const wire = req.effort && req.model.effort ? req.model.effort.values?.[req.effort] : undefined;
    const interleaved = this.meta(modelId)?.interleaved ?? null;
    const build = (withStreamOptions: boolean, withReasoning: boolean): Record<string, unknown> => ({
      model: modelId,
      stream: true,
      messages: toChatMessages(req.system, req.messages, req.model.supportsVision, { kind: this.kind, model: modelId }),
      ...(req.tools.length > 0 && req.model.supportsTools
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.inputSchema }
            }))
          }
        : {}),
      ...(this.kind === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      ...(withStreamOptions ? { stream_options: { include_usage: true } } : {}),
      ...(withReasoning ? this.reasoningParams(wire) : {}),
      ...(this.kind === 'openai' ? { prompt_cache_key: req.cacheKey, store: false } : {}),
      ...(this.kind === 'openrouter' ? routingPrivacy(req.privacy) : {}),
      ...(this.kind === 'openrouter' && BREAKPOINT_CACHING.test(modelId) ? { cache_control: { type: 'ephemeral' } } : {})
    });

    const url = joinUrl(this.base, 'chat/completions');
    let streamOptions = !this.noStreamOptions.has(modelId);
    let reasoningParam = !this.noReasoningParam.has(modelId);
    let response: Response | null = null;
    // Some OpenAI-compatible servers reject optional parameters, or a reply budget their model can't give:
    // drop the parameter the error names, or lower the budget, and retry.
    let refusal: ProviderError | null = null;
    for (let attempt = 0; attempt < 6 && !response; attempt++) {
      try {
        response = await request({ url, headers: this.headers(), body: build(streamOptions, reasoningParam), signal, timeoutMs: 120_000 });
      } catch (error) {
        if (this.kind === 'openrouter') throwIfPrivacyBlocked(error, req.privacy);
        // A model chat completions doesn't serve: this one is answered by the Responses API.
        if (this.kind === 'openai' && onlyInResponses(error)) {
          this.responsesOnly.add(modelId);
          yield* this.streamResponses(req, signal);
          return;
        }
        if (!(error instanceof ProviderError) || (error.code !== 'bad_request' && error.code !== 'context_length')) throw error;
        refusal = error;
        const smaller = smallerReplyBudget(error.message, maxTokens);
        if (error.code === 'bad_request' && streamOptions && /stream_options/i.test(error.message)) {
          this.noStreamOptions.add(modelId);
          streamOptions = false;
        } else if (error.code === 'bad_request' && reasoningParam && wire !== undefined && this.kind === 'openai-compatible' && /reasoning/i.test(error.message)) {
          this.noReasoningParam.add(modelId);
          reasoningParam = false;
        } else if (smaller !== null) {
          this.replyBudget.set(modelId, smaller);
          maxTokens = smaller;
        } else {
          throw error;
        }
      }
    }
    if (!response) throw refusal ?? new ProviderError('bad_request', 'The provider rejected the request.');
    if (!response.body) throw new ProviderError('server', 'The provider returned an empty stream.');

    let text = '';
    let thinking = '';
    const details: Array<Record<string, unknown>> = [];
    const calls: Array<{ id: string; name: string; args: string }> = [];
    let finish: string | null = null;
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let costUsd: number | undefined;

    for await (const msg of parseSse(response.body)) {
      if (signal.aborted) throw new ProviderError('aborted', 'Request cancelled.');
      if (msg.data === '[DONE]') break;
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(msg.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const err = chunk.error as { message?: string; code?: number | string } | undefined;
      if (err) {
        const code = Number(err.code);
        throw new ProviderError(code === 429 ? 'rate_limit' : code >= 500 ? 'server' : 'unknown', err.message ?? 'Provider error', {
          retryable: code === 429 || code >= 500
        });
      }
      const u = chunk.usage as
        | {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
            cost?: number;
            cost_details?: { upstream_inference_cost?: number | null };
          }
        | undefined;
      if (u) {
        // prompt_tokens counts every input token; cache reads and writes are reported inside it.
        const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
        const written = u.prompt_tokens_details?.cache_write_tokens ?? 0;
        usage.inputTokens = Math.max(0, (u.prompt_tokens ?? 0) - cached - written);
        usage.cacheReadTokens = cached;
        usage.cacheWriteTokens = written;
        usage.outputTokens = u.completion_tokens ?? 0;
        // OpenRouter reports what it charged; with your own upstream key the upstream bill comes on top.
        if (this.kind === 'openrouter' && typeof u.cost === 'number') costUsd = u.cost + (u.cost_details?.upstream_inference_cost ?? 0);
      }
      const choice = (chunk.choices as Array<Record<string, unknown>> | undefined)?.[0];
      if (!choice) continue;
      const delta = (choice.delta ?? {}) as Record<string, unknown>;
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        text += delta.content;
        yield { type: 'text-delta', text: delta.content };
      }
      const reasoning = typeof delta.reasoning === 'string' ? delta.reasoning : delta.reasoning_content;
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        thinking += reasoning;
        yield { type: 'thinking-delta', text: reasoning };
      }
      if (Array.isArray(delta.reasoning_details)) {
        for (const fragment of delta.reasoning_details) mergeReasoningDetail(details, fragment);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const raw of delta.tool_calls as Array<Record<string, unknown>>) {
          const index = typeof raw.index === 'number' ? raw.index : calls.length;
          const slot = (calls[index] ??= { id: '', name: '', args: '' });
          if (typeof raw.id === 'string' && raw.id) slot.id = raw.id;
          const fn = raw.function as { name?: string; arguments?: string } | undefined;
          if (fn?.name && !slot.name) slot.name = fn.name;
          if (typeof fn?.arguments === 'string') slot.args += fn.arguments;
        }
      }
      if (typeof choice.finish_reason === 'string') finish = choice.finish_reason;
    }

    if (thinking.length > 0) yield { type: 'block', block: { type: 'thinking', text: thinking, display: 'summary', origin: this.kind } };
    const replay = this.replayFor(modelId, details, thinking, interleaved);
    if (replay) yield { type: 'block', block: { type: 'provider', provider: this.kind, raw: replay, summary: '' } };
    if (text.length > 0) yield { type: 'block', block: { type: 'text', text } };
    for (const call of calls.filter(Boolean)) {
      const id = call.id || `call_${randomUUID().slice(0, 8)}`;
      if (call.args.trim().length === 0) {
        yield { type: 'block', block: { type: 'tool_use', id, name: call.name, input: {} } };
        continue;
      }
      try {
        yield { type: 'block', block: { type: 'tool_use', id, name: call.name, input: JSON.parse(call.args) as unknown } };
      } catch {
        yield { type: 'block', block: { type: 'tool_use', id, name: call.name, input: call.args, meta: { invalidJson: 'true' } } };
      }
    }
    yield { type: 'usage', usage, ...(costUsd !== undefined ? { costUsd } : {}) };
    yield { type: 'finish', reason: calls.length > 0 && finish !== 'length' ? 'tool_use' : mapFinish(finish) };
  }

  /** One reply from the Responses API, for the models that chat completions does not serve. */
  private async *streamResponses(req: StreamRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const modelId = req.model.ref.modelId;
    const wire = req.effort && req.model.effort ? req.model.effort.values?.[req.effort] : undefined;
    const effort = typeof wire === 'string' ? wire : undefined;
    const maxTokens = Math.min(req.model.maxOutputTokens, 64_000);
    const url = joinUrl(this.base, 'responses');
    let summary = true;
    let encrypted = true;
    let response: Response | null = null;
    // An account that may not have reasoning summaries, or the encrypted reasoning, gets the request without them.
    for (let attempt = 0; attempt < 3 && !response; attempt++) {
      try {
        response = await request({ url, headers: this.headers(), body: responsesBody(req, { effort, summary, encrypted, maxTokens }), signal, timeoutMs: 120_000 });
      } catch (error) {
        if (!(error instanceof ProviderError) || error.code !== 'bad_request') throw error;
        if (summary && /summar/i.test(error.message)) summary = false;
        else if (encrypted && /encrypted_content|include/i.test(error.message)) encrypted = false;
        else throw error;
      }
    }
    if (!response) throw new ProviderError('bad_request', 'The provider rejected the request.');
    if (!response.body) throw new ProviderError('server', 'The provider returned an empty stream.');
    yield* readResponsesStream(response.body, signal, modelId);
  }

  /** Request fields for the chosen effort, in each API's own shape. */
  private reasoningParams(wire: string | number | undefined): Record<string, unknown> {
    if (wire === undefined) return {};
    if (this.kind === 'openrouter') return { reasoning: typeof wire === 'number' ? { max_tokens: wire } : { effort: wire } };
    return typeof wire === 'string' ? { reasoning_effort: wire } : {};
  }

  /** Reasoning to save for the next request of a tool loop, when the API needs it back. */
  private replayFor(model: string, details: Array<Record<string, unknown>>, thinking: string, interleaved: string | null): ReasoningReplay | null {
    const kept = details.filter((d): d is Record<string, unknown> => Boolean(d));
    if (kept.length > 0 && (this.kind === 'openrouter' || interleaved === 'reasoning_details')) return { model, reasoning_details: kept };
    if (thinking.length > 0 && this.kind === 'openai-compatible' && interleaved === 'reasoning_content') return { model, reasoning_content: thinking };
    return null;
  }
}

/** OpenRouter's per-request data policy: skip providers that train on or keep prompts. */
function routingPrivacy(privacy: RequestPrivacy): Record<string, unknown> {
  if (!privacy.noTraining && !privacy.zeroRetention) return {};
  return { provider: { data_collection: 'deny', ...(privacy.zeroRetention ? { zdr: true } : {}) } };
}

/** OpenRouter answers 404 when no provider of a model meets the data policy; say what to do instead. */
function throwIfPrivacyBlocked(error: unknown, privacy: RequestPrivacy): void {
  if (!(error instanceof ProviderError) || error.code !== 'not_found') return;
  if (!/polic|retention|\bzdr\b/i.test(error.message)) return;
  const message = privacy.zeroRetention
    ? "No OpenRouter provider of this model keeps zero data, so this incognito chat can't use it. Pick another model."
    : 'Every OpenRouter provider of this model may store or train on prompts, so Graft didn\'t send it. Pick another model, or turn off "Ask providers not to train on my data" in Settings → Privacy.';
  throw new ProviderError('bad_request', message, { status: 404, retryable: false, cause: error });
}

function firstSentence(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const match = /^(.{20,140}?[.!?])(\s|$)/.exec(clean);
  return match?.[1] ?? (clean.length > 140 ? `${clean.slice(0, 137)}…` : clean);
}
