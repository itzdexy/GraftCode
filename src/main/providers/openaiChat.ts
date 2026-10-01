import { randomUUID } from 'node:crypto';
import type { ProviderKind, Usage } from '@shared/schemas/common';
import type { ContentBlock, LlmMessage } from '@shared/schemas/messages';
import type { CustomModel, ModelInfo } from '@shared/schemas/models';
import { arrangeModels, describeCapabilities, familyOf, isFastTier, labelFromId } from './catalog';
import { ProviderError } from './errors';
import { hostOf, joinUrl, request, requestJson } from './http';
import { catalogEffort, modelPricing, NATIVE_PRESET, type CatalogModel, type ProviderCatalog } from './presets';
import { parseSse } from './sse';
import type { FinishReason, LLMProvider, ProviderConnection, RequestPrivacy, StreamEvent, StreamRequest } from './types';

type ChatKind = Extract<ProviderKind, 'openai' | 'openrouter' | 'openai-compatible'>;

const DEFAULT_BASE: Record<ChatKind, string | null> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  'openai-compatible': null
};

/** Model ids on the OpenAI list endpoint that cannot serve chat completions. */
const NON_CHAT = /(embed|whisper|tts|dall-e|davinci|babbage|moderation|audio|realtime|transcribe|image|search|computer-use|sora|codex)/i;
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

interface OpenAiModel {
  id: string;
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
  /** Catalog entry used for model metadata. */
  private readonly presetId: string | null;
  private readonly noStreamOptions = new Set<string>();
  private readonly noReasoningParam = new Set<string>();

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
    this.presetId = connection.preset ?? NATIVE_PRESET[connection.kind] ?? null;
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
    return this.catalog?.model(this.presetId, modelId) ?? null;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    // OpenRouter's catalog is public, so confirm the key against an authenticated endpoint first.
    if (this.kind === 'openrouter') {
      await requestJson<unknown>({ url: joinUrl(this.base, 'key'), headers: this.headers(), ...(signal ? { signal } : {}) });
    }
    let listed: OpenAiModel[];
    try {
      const body = await requestJson<{ data?: OpenAiModel[] }>({
        url: joinUrl(this.base, 'models'),
        headers: this.headers(),
        ...(signal ? { signal } : {})
      });
      if (!Array.isArray(body.data)) {
        throw new ProviderError('bad_base_url', `${hostOf(this.base)} did not return a model list — check the base URL.`, { retryable: false });
      }
      listed = body.data.filter((m) => typeof m.id === 'string');
    } catch (error) {
      // Some providers have no list endpoint: confirm the key with a one-token request and offer the catalog's models.
      const known = this.kind === 'openai-compatible' && this.presetId ? (this.catalog?.models(this.presetId) ?? []) : [];
      const listMissing = error instanceof ProviderError && (error.code === 'not_found' || error.code === 'bad_base_url');
      const first = known.find((m) => !m.deprecated) ?? known[0];
      if (!listMissing || !first) throw error;
      await this.ping(first.id, signal);
      listed = known.filter((m) => !m.deprecated).map((m) => ({ id: m.id }));
    }
    const models = listed
      .filter((m) => {
        if (this.kind === 'openai') return !NON_CHAT.test(m.id);
        if (this.kind === 'openai-compatible') return this.meta(m.id) !== null || !NON_CHAT_LIGHT.test(m.id);
        return true;
      })
      .map((m) => this.toModelInfo(m));
    const ids = new Set(models.map((m) => m.ref.modelId));
    for (const custom of this.customModels) {
      if (!ids.has(custom.id)) models.push(this.toModelInfo({ id: custom.id }));
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
    let context = meta?.context ?? 32_768;
    let output = meta?.output ?? 8_192;
    let reasoning = meta?.reasoning ?? false;
    let vision = meta?.vision ?? false;
    let tools = meta ? meta.tools : true;
    let pricing = modelPricing(meta?.pricing ?? null);
    if (this.kind === 'openai' && !meta) {
      const hint = OPENAI_LIMITS.find((h) => h.prefix.test(m.id));
      if (hint) ({ context, output, reasoning, vision } = hint);
      else ({ context, output, vision } = { context: 128_000, output: 16_384, vision: true });
    } else if (this.kind === 'openrouter') {
      context = m.context_length ?? context;
      output = m.top_provider?.max_completion_tokens ?? meta?.output ?? Math.min(32_768, Math.floor(context / 4));
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
          : describeCapabilities({ contextWindow: context, supportsVision: vision, effort, supportsTools: tools }),
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
    const maxTokens = Math.min(req.model.maxOutputTokens, 64_000);
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
    // Some OpenAI-compatible servers reject optional parameters; drop the one named in the error and retry.
    for (let attempt = 0; attempt < 3 && !response; attempt++) {
      try {
        response = await request({ url, headers: this.headers(), body: build(streamOptions, reasoningParam), signal, timeoutMs: 120_000 });
      } catch (error) {
        if (this.kind === 'openrouter') throwIfPrivacyBlocked(error, req.privacy);
        if (!(error instanceof ProviderError) || error.code !== 'bad_request') throw error;
        if (streamOptions && /stream_options/i.test(error.message)) {
          this.noStreamOptions.add(modelId);
          streamOptions = false;
        } else if (reasoningParam && wire !== undefined && this.kind === 'openai-compatible' && /reasoning/i.test(error.message)) {
          this.noReasoningParam.add(modelId);
          reasoningParam = false;
        } else {
          throw error;
        }
      }
    }
    if (!response) throw new ProviderError('bad_request', 'The provider rejected the request.');
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
