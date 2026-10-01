import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError
} from '@anthropic-ai/sdk';
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaRawMessageStreamEvent,
  BetaThinkingConfigParam,
  BetaToolUnion,
  MessageCreateParamsStreaming
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ModelInfo as SdkModelInfo } from '@anthropic-ai/sdk/resources/models';
import type { EffortLevel, Usage } from '@shared/schemas/common';
import type { ContentBlock, LlmMessage } from '@shared/schemas/messages';
import type { ModelInfo } from '@shared/schemas/models';
import {
  arrangeModels,
  describeCapabilities,
  effortSupport,
  familyOf,
  isFastTier,
  nearestAvailable,
  THINKING_BUDGETS
} from './catalog';
import { errorFromHttp, errorFromNetwork, ProviderError } from './errors';
import type { FinishReason, LLMProvider, ProviderConnection, StreamEvent, StreamRequest } from './types';

type WireEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Capabilities we act on, read from the Models API. */
export interface AnthropicCaps {
  adaptive: boolean;
  budget: boolean;
  effort: Partial<Record<WireEffort, true>>;
  vision: boolean;
  maxOutput: number;
  contextWindow: number;
}

const BETA_DISPLAY_UPDATES = 'thinking-display-updates-2026-08-18';
const WEB_SEARCH_TYPES = ['web_search_20260209', 'web_search_20250305'] as const;
type WebSearchType = (typeof WEB_SEARCH_TYPES)[number];

export function capsFromModel(m: SdkModelInfo): AnthropicCaps {
  const c = m.capabilities;
  const effort: Partial<Record<WireEffort, true>> = {};
  if (c?.effort.supported) {
    if (c.effort.low.supported) effort.low = true;
    if (c.effort.medium.supported) effort.medium = true;
    if (c.effort.high.supported) effort.high = true;
    if (c.effort.xhigh?.supported) effort.xhigh = true;
    if (c.effort.max.supported) effort.max = true;
  }
  return {
    adaptive: c?.thinking.types.adaptive.supported ?? false,
    budget: c?.thinking.types.enabled.supported ?? false,
    effort,
    vision: c?.image_input.supported ?? false,
    maxOutput: m.max_tokens ?? 8192,
    contextWindow: m.max_input_tokens ?? 200_000
  };
}

/** UI effort levels a model can honor, derived from its wire capabilities. */
export function levelsFor(caps: AnthropicCaps): EffortLevel[] {
  if (Object.keys(caps.effort).length > 0) {
    const levels: EffortLevel[] = [];
    if (caps.effort.low) levels.push('low');
    if (caps.effort.medium) levels.push('medium');
    if (caps.effort.high) levels.push('high');
    if (caps.effort.xhigh) levels.push('extra');
    if (caps.effort.max) levels.push('max');
    if (caps.effort.max || caps.effort.xhigh) levels.push('taproot');
    return levels;
  }
  if (caps.budget) return ['low', 'medium', 'high', 'extra', 'max', 'taproot'];
  return [];
}

export function wireEffort(level: EffortLevel, caps: AnthropicCaps): WireEffort | undefined {
  const table: Partial<Record<EffortLevel, WireEffort>> = {};
  if (caps.effort.low) table.low = 'low';
  if (caps.effort.medium) table.medium = 'medium';
  if (caps.effort.high) table.high = 'high';
  if (caps.effort.xhigh) table.extra = 'xhigh';
  if (caps.effort.max) table.max = 'max';
  if (caps.effort.max) table.taproot = 'max';
  else if (caps.effort.xhigh) table.taproot = 'xhigh';
  return nearestAvailable(level, table);
}

export function toModelInfo(providerId: string, m: SdkModelInfo): ModelInfo {
  const caps = capsFromModel(m);
  const effort = effortSupport(levelsFor(caps));
  const base = {
    contextWindow: caps.contextWindow,
    supportsVision: caps.vision,
    effort,
    supportsTools: true
  };
  return {
    ref: { providerId, modelId: m.id },
    label: m.display_name || m.id,
    description: describeCapabilities(base),
    family: familyOf(m.id),
    contextWindow: caps.contextWindow,
    maxOutputTokens: caps.maxOutput,
    supportsTools: true,
    supportsVision: caps.vision,
    supportsWebSearch: true,
    effort,
    featured: false,
    cheap: isFastTier(m.id),
    createdAt: Number.isNaN(Date.parse(m.created_at)) ? null : Date.parse(m.created_at),
    pricing: null
  };
}

function mapSdkError(error: unknown, where: string): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof APIUserAbortError) return new ProviderError('aborted', 'Request cancelled.', { cause: error });
  if (error instanceof APIConnectionTimeoutError) {
    return new ProviderError('network', `${where} did not respond in time.`, { cause: error });
  }
  if (error instanceof APIConnectionError) return errorFromNetwork(error.cause ?? error, where);
  if (error instanceof APIError && typeof error.status === 'number') {
    const body = error.error ? JSON.stringify(error.error) : error.message;
    const headers = error.headers as Headers | undefined;
    const mapped = errorFromHttp(error.status, body, headers, where);
    return new ProviderError(mapped.code, mapped.message, {
      status: error.status,
      retryable: mapped.retryable,
      ...(mapped.retryAfterMs !== undefined ? { retryAfterMs: mapped.retryAfterMs } : {}),
      cause: error
    });
  }
  if (error instanceof APIError) {
    // Errors delivered inside the event stream carry a type but no status.
    const type = (error.error as { error?: { type?: string } } | undefined)?.error?.type ?? '';
    if (type === 'overloaded_error') return new ProviderError('overloaded', `The provider is overloaded: ${error.message}`, { cause: error });
    if (type === 'rate_limit_error') return new ProviderError('rate_limit', `Rate limited: ${error.message}`, { cause: error });
    if (type === 'api_error') return new ProviderError('server', `Provider error: ${error.message}`, { cause: error });
    return new ProviderError('unknown', error.message, { cause: error, retryable: false });
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new ProviderError('aborted', 'Request cancelled.', { cause: error });
  }
  return new ProviderError('unknown', error instanceof Error ? error.message : String(error), { cause: error, retryable: false });
}

/** Converts neutral history to the Messages API shape. Unsigned or foreign thinking is dropped. */
export function toAnthropicMessages(messages: LlmMessage[], vision: boolean): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  for (const message of messages) {
    const content: BetaContentBlockParam[] = [];
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          if (block.text.length > 0) content.push({ type: 'text', text: block.text });
          break;
        case 'image':
          if (vision) {
            content.push({ type: 'image', source: { type: 'base64', media_type: block.mediaType, data: block.data } });
          } else {
            content.push({ type: 'text', text: '[An image was attached, but this model cannot view images.]' });
          }
          break;
        case 'thinking':
          if (message.role === 'assistant' && block.origin === 'anthropic' && block.signature) {
            content.push({ type: 'thinking', thinking: block.text, signature: block.signature });
          }
          break;
        case 'redacted_thinking':
          if (message.role === 'assistant') content.push({ type: 'redacted_thinking', data: block.data });
          break;
        case 'tool_use':
          content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} });
          break;
        case 'tool_result':
          content.push({
            type: 'tool_result',
            tool_use_id: block.toolUseId,
            is_error: block.isError,
            content: block.content.map((item) =>
              item.type === 'text'
                ? { type: 'text' as const, text: item.text.length > 0 ? item.text : '(no output)' }
                : vision
                  ? { type: 'image' as const, source: { type: 'base64' as const, media_type: item.mediaType, data: item.data } }
                  : { type: 'text' as const, text: '[image output omitted: model cannot view images]' }
            )
          });
          break;
        case 'provider':
          if (block.provider === 'anthropic') content.push(block.raw as BetaContentBlockParam);
          break;
      }
    }
    if (content.length === 0) continue;
    out.push({ role: message.role, content });
  }
  return out;
}

interface OpenBlock {
  kind: 'text' | 'thinking' | 'redacted' | 'tool_use' | 'other';
  text: string;
  signature: string;
  json: string;
  raw: Record<string, unknown>;
}

function summarizeServerBlock(raw: Record<string, unknown>): string {
  if (raw.type === 'server_tool_use') {
    const input = raw.input as { query?: unknown } | undefined;
    return typeof input?.query === 'string' ? `Searched the web for “${input.query}”` : `Used ${String(raw.name)}`;
  }
  if (raw.type === 'web_search_tool_result') {
    const content = raw.content;
    return Array.isArray(content) ? `${content.length} web results` : 'Web search failed';
  }
  return String(raw.type);
}

/** Server-side web search blocks in the shape the transcript shows. */
function searchOf(raw: Record<string, unknown>): { query: string; results: Array<{ title: string; url: string }> } | null {
  if (raw.type === 'server_tool_use' && raw.name === 'web_search') {
    const input = raw.input as { query?: unknown } | undefined;
    return { query: typeof input?.query === 'string' ? input.query : '', results: [] };
  }
  if (raw.type === 'web_search_tool_result' && Array.isArray(raw.content)) {
    const results = (raw.content as Array<{ type?: unknown; url?: unknown; title?: unknown }>)
      .filter((r) => r.type === 'web_search_result' && typeof r.url === 'string')
      .map((r) => ({ title: typeof r.title === 'string' ? r.title : String(r.url), url: String(r.url) }));
    return { query: '', results };
  }
  return null;
}

function mapStop(reason: string | null): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'pause_turn':
      return 'pause';
    case 'model_context_window_exceeded':
      return 'context_window';
    default:
      return 'other';
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly kind = 'anthropic' as const;
  readonly id: string;
  private readonly client: Anthropic;
  private readonly where: string;
  private readonly caps = new Map<string, AnthropicCaps>();
  /** Per-model fallbacks learned from 400s (display mode, web search tool version). */
  private readonly noUpdatesDisplay = new Set<string>();
  private readonly webSearchType = new Map<string, WebSearchType | null>();

  constructor(connection: ProviderConnection) {
    if (!connection.apiKey) throw new ProviderError('auth', 'An API key is required.', { retryable: false });
    this.id = connection.id;
    const baseURL = connection.baseUrl ?? 'https://api.anthropic.com';
    this.where = new URL(baseURL).host;
    this.client = new Anthropic({ apiKey: connection.apiKey, baseURL, maxRetries: 0, timeout: 15 * 60_000 });
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    try {
      for await (const m of this.client.models.list({ limit: 100 }, signal ? { signal } : {})) {
        this.caps.set(m.id, capsFromModel(m));
        models.push(toModelInfo(this.id, m));
      }
    } catch (error) {
      throw mapSdkError(error, this.where);
    }
    return arrangeModels(models);
  }

  private async capsFor(modelId: string, signal: AbortSignal): Promise<AnthropicCaps> {
    const cached = this.caps.get(modelId);
    if (cached) return cached;
    try {
      const m = await this.client.models.retrieve(modelId, {}, { signal });
      const caps = capsFromModel(m);
      this.caps.set(modelId, caps);
      return caps;
    } catch (error) {
      throw mapSdkError(error, this.where);
    }
  }

  private buildParams(request: StreamRequest, caps: AnthropicCaps): MessageCreateParamsStreaming {
    const modelId = request.model.ref.modelId;
    const betas: string[] = [];
    const taproot = request.effort === 'taproot';
    let maxTokens = Math.min(caps.maxOutput, taproot ? 128_000 : 64_000);
    let thinking: BetaThinkingConfigParam | undefined;
    let effort: WireEffort | undefined;

    if (caps.adaptive) {
      const display = this.noUpdatesDisplay.has(modelId) ? 'summarized' : 'updates';
      if (display === 'updates') betas.push(BETA_DISPLAY_UPDATES);
      thinking = { type: 'adaptive', display };
      if (request.effort) effort = wireEffort(request.effort, caps);
    } else if (caps.budget && request.effort && request.effort !== 'low') {
      const budget = THINKING_BUDGETS[request.effort];
      maxTokens = Math.min(caps.maxOutput, Math.max(maxTokens, budget + 8192));
      thinking = { type: 'enabled', budget_tokens: Math.min(budget, maxTokens - 1024) };
    }

    const tools: BetaToolUnion[] = request.tools.map((tool, i) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as { type: 'object'; [key: string]: unknown },
      eager_input_streaming: true,
      ...(i === request.tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {})
    }));
    const searchType = this.webSearchType.has(modelId) ? this.webSearchType.get(modelId) : WEB_SEARCH_TYPES[0];
    if (request.webSearch && searchType) {
      tools.push({ type: searchType, name: 'web_search', max_uses: 5 });
    }

    return {
      model: modelId,
      max_tokens: maxTokens,
      stream: true,
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      messages: toAnthropicMessages(request.messages, caps.vision),
      ...(tools.length > 0 ? { tools } : {}),
      ...(thinking ? { thinking } : {}),
      ...(effort ? { output_config: { effort } } : {}),
      cache_control: { type: 'ephemeral' },
      ...(betas.length > 0 ? { betas } : {})
    };
  }

  async *streamText(request: StreamRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const modelId = request.model.ref.modelId;
    const caps = await this.capsFor(modelId, signal);
    let stream: AsyncIterable<BetaRawMessageStreamEvent>;
    for (let attempt = 0; ; attempt++) {
      try {
        stream = await this.client.beta.messages.create(this.buildParams(request, caps), { signal });
        break;
      } catch (raw) {
        const error = mapSdkError(raw, this.where);
        // Learn per-model fallbacks from specific validation errors, then retry at once.
        if (error.code === 'bad_request' && attempt < 3) {
          if (/display/i.test(error.message) && !this.noUpdatesDisplay.has(modelId)) {
            this.noUpdatesDisplay.add(modelId);
            continue;
          }
          if (request.webSearch && /web_search/i.test(error.message)) {
            const current = this.webSearchType.has(modelId) ? this.webSearchType.get(modelId) : WEB_SEARCH_TYPES[0];
            const next = current === WEB_SEARCH_TYPES[0] ? WEB_SEARCH_TYPES[1] : null;
            this.webSearchType.set(modelId, next);
            continue;
          }
        }
        throw error;
      }
    }

    const displayMode = this.noUpdatesDisplay.has(modelId) ? 'summary' : 'update';
    const blocks = new Map<number, OpenBlock>();
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let stopReason: string | null = null;

    try {
      for await (const event of stream) {
        switch (event.type) {
          case 'message_start': {
            const u = event.message.usage;
            usage.inputTokens = u.input_tokens ?? 0;
            usage.cacheReadTokens = u.cache_read_input_tokens ?? 0;
            usage.cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
            usage.outputTokens = u.output_tokens ?? 0;
            break;
          }
          case 'content_block_start': {
            const cb = event.content_block as unknown as Record<string, unknown>;
            const kind: OpenBlock['kind'] =
              cb.type === 'text'
                ? 'text'
                : cb.type === 'thinking'
                  ? 'thinking'
                  : cb.type === 'redacted_thinking'
                    ? 'redacted'
                    : cb.type === 'tool_use'
                      ? 'tool_use'
                      : 'other';
            blocks.set(event.index, {
              kind,
              text: typeof cb.text === 'string' ? cb.text : typeof cb.thinking === 'string' ? cb.thinking : '',
              signature: typeof cb.signature === 'string' ? cb.signature : '',
              json: '',
              raw: { ...cb }
            });
            break;
          }
          case 'content_block_delta': {
            const open = blocks.get(event.index);
            if (!open) break;
            const delta = event.delta as unknown as Record<string, unknown>;
            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
              open.text += delta.text;
              yield { type: 'text-delta', text: delta.text };
            } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
              open.text += delta.thinking;
              yield { type: 'thinking-delta', text: delta.thinking };
            } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
              open.signature += delta.signature;
            } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
              open.json += delta.partial_json;
            }
            break;
          }
          case 'content_block_stop': {
            const open = blocks.get(event.index);
            if (!open) break;
            blocks.delete(event.index);
            const block = finishBlock(open, displayMode);
            if (block) yield { type: 'block', block };
            break;
          }
          case 'message_delta': {
            stopReason = event.delta.stop_reason ?? stopReason;
            const u = event.usage;
            if (typeof u.output_tokens === 'number') usage.outputTokens = u.output_tokens;
            if (typeof u.input_tokens === 'number') usage.inputTokens = u.input_tokens;
            if (typeof u.cache_read_input_tokens === 'number') usage.cacheReadTokens = u.cache_read_input_tokens;
            if (typeof u.cache_creation_input_tokens === 'number') usage.cacheWriteTokens = u.cache_creation_input_tokens;
            break;
          }
          case 'message_stop':
            break;
          default:
            break;
        }
      }
    } catch (error) {
      throw mapSdkError(error, this.where);
    }
    yield { type: 'usage', usage };
    yield { type: 'finish', reason: mapStop(stopReason) };
  }
}

function finishBlock(open: OpenBlock, displayMode: 'update' | 'summary'): ContentBlock | null {
  switch (open.kind) {
    case 'text':
      return { type: 'text', text: open.text };
    case 'thinking':
      return {
        type: 'thinking',
        text: open.text,
        ...(open.signature ? { signature: open.signature } : {}),
        display: displayMode,
        origin: 'anthropic'
      };
    case 'redacted':
      return typeof open.raw.data === 'string' ? { type: 'redacted_thinking', data: open.raw.data } : null;
    case 'tool_use': {
      const id = String(open.raw.id);
      const name = String(open.raw.name);
      if (open.json.trim().length === 0) return { type: 'tool_use', id, name, input: {} };
      try {
        return { type: 'tool_use', id, name, input: JSON.parse(open.json) as unknown };
      } catch {
        // Truncated or malformed streamed input: the loop answers with an error result.
        return { type: 'tool_use', id, name, input: open.json, meta: { invalidJson: 'true' } };
      }
    }
    case 'other': {
      const raw = { ...open.raw };
      if (open.json.trim().length > 0) {
        try {
          raw.input = JSON.parse(open.json) as unknown;
        } catch {
          raw.input = {};
        }
      }
      const search = searchOf(raw);
      return { type: 'provider', provider: 'anthropic', raw, summary: summarizeServerBlock(raw), ...(search ? { search } : {}) };
    }
  }
}
