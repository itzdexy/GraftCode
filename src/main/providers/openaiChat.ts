import { randomUUID } from 'node:crypto';
import type { EffortLevel, ProviderKind, Usage } from '@shared/schemas/common';
import type { ContentBlock, LlmMessage } from '@shared/schemas/messages';
import type { CustomModel, ModelInfo } from '@shared/schemas/models';
import { arrangeModels, describeCapabilities, effortSupport, familyOf, isFastTier, labelFromId } from './catalog';
import { ProviderError } from './errors';
import { hostOf, joinUrl, request, requestJson } from './http';
import { parseSse } from './sse';
import type { FinishReason, LLMProvider, ProviderConnection, StreamEvent, StreamRequest } from './types';

type ChatKind = Extract<ProviderKind, 'openai' | 'openrouter' | 'openai-compatible'>;

const DEFAULT_BASE: Record<ChatKind, string | null> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  'openai-compatible': null
};

/** Model ids on the OpenAI list endpoint that cannot serve chat completions. */
const NON_CHAT = /(embed|whisper|tts|dall-e|davinci|babbage|moderation|audio|realtime|transcribe|image|search|computer-use|sora|codex)/i;

/**
 * Size hints for the OpenAI catalog, whose list endpoint returns ids only.
 * Keyed by id prefix; the first match wins. Other providers report limits.
 */
const OPENAI_LIMITS: Array<{ prefix: RegExp; context: number; output: number; reasoning: boolean; vision: boolean }> = [
  { prefix: /^gpt-5/, context: 400_000, output: 128_000, reasoning: true, vision: true },
  { prefix: /^o\d/, context: 200_000, output: 100_000, reasoning: true, vision: true },
  { prefix: /^gpt-4\.1/, context: 1_047_576, output: 32_768, reasoning: false, vision: true },
  { prefix: /^(gpt-4o|chatgpt-4o)/, context: 128_000, output: 16_384, reasoning: false, vision: true },
  { prefix: /^gpt-4/, context: 128_000, output: 8_192, reasoning: false, vision: false },
  { prefix: /^gpt-3\.5/, context: 16_385, output: 4_096, reasoning: false, vision: false }
];

const OPENAI_EFFORT: Partial<Record<EffortLevel, 'low' | 'medium' | 'high'>> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  extra: 'high',
  max: 'high',
  taproot: 'high'
};

interface OpenAiModel {
  id: string;
  created?: number;
  name?: string;
  description?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[] };
  supported_parameters?: string[];
  top_provider?: { max_completion_tokens?: number | null };
  pricing?: { prompt?: string; completion?: string };
}

type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ChatContentPart[] }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Converts neutral history into chat-completions messages (tool results become role "tool"). */
export function toChatMessages(system: string, messages: LlmMessage[], vision: boolean): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }];
  for (const message of messages) {
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
      if (text.length === 0 && calls.length === 0) continue;
      out.push({ role: 'assistant', content: text.length > 0 ? text : null, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
      continue;
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
    if (parts.length === 0) continue;
    const onlyText = parts.every((p) => p.type === 'text');
    out.push({ role: 'user', content: onlyText ? parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n\n') : parts });
  }
  return out;
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
  private readonly noStreamOptions = new Set<string>();

  constructor(connection: ProviderConnection & { kind: ChatKind }, customModels: CustomModel[] = []) {
    this.id = connection.id;
    this.kind = connection.kind;
    const base = connection.baseUrl ?? DEFAULT_BASE[connection.kind];
    if (!base) throw new ProviderError('bad_base_url', 'A base URL is required for a custom endpoint.', { retryable: false });
    this.base = base;
    this.apiKey = connection.apiKey;
    this.customModels = customModels;
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

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    // OpenRouter's catalog is public, so confirm the key against an authenticated endpoint first.
    if (this.kind === 'openrouter') {
      await requestJson<unknown>({ url: joinUrl(this.base, 'key'), headers: this.headers(), ...(signal ? { signal } : {}) });
    }
    const body = await requestJson<{ data?: OpenAiModel[] }>({
      url: joinUrl(this.base, 'models'),
      headers: this.headers(),
      ...(signal ? { signal } : {})
    });
    if (!Array.isArray(body.data)) {
      throw new ProviderError('bad_base_url', `${hostOf(this.base)} did not return a model list — check the base URL.`, {
        retryable: false
      });
    }
    const models = body.data
      .filter((m) => typeof m.id === 'string' && (this.kind !== 'openai' || !NON_CHAT.test(m.id)))
      .map((m) => this.toModelInfo(m));
    const listed = new Set(models.map((m) => m.ref.modelId));
    for (const custom of this.customModels) {
      if (!listed.has(custom.id)) models.push(this.toModelInfo({ id: custom.id }));
    }
    return arrangeModels(models);
  }

  private toModelInfo(m: OpenAiModel): ModelInfo {
    const custom = this.customModels.find((c) => c.id === m.id);
    let context = 32_768;
    let output = 8_192;
    let reasoning = false;
    let vision = false;
    let tools = true;
    let pricing: ModelInfo['pricing'] = null;
    if (this.kind === 'openai') {
      const hint = OPENAI_LIMITS.find((h) => h.prefix.test(m.id));
      if (hint) ({ context, output, reasoning, vision } = hint);
      else ({ context, output, vision } = { context: 128_000, output: 16_384, vision: true });
    } else if (this.kind === 'openrouter') {
      context = m.context_length ?? context;
      output = m.top_provider?.max_completion_tokens ?? Math.min(32_768, Math.floor(context / 4));
      const params = m.supported_parameters ?? [];
      reasoning = params.includes('reasoning');
      tools = params.includes('tools');
      vision = (m.architecture?.input_modalities ?? []).includes('image');
      const input = perMillion(m.pricing?.prompt);
      const out = perMillion(m.pricing?.completion);
      pricing = input !== null && out !== null ? { input, output: out } : null;
    }
    if (custom) {
      context = custom.contextWindow ?? context;
      output = custom.maxOutputTokens ?? output;
      vision = custom.vision ?? vision;
    }
    const effort = reasoning ? effortSupport(['low', 'medium', 'high', 'taproot']) : null;
    return {
      ref: { providerId: this.id, modelId: m.id },
      label: custom?.label ?? m.name ?? labelFromId(m.id),
      description:
        this.kind === 'openrouter' && m.description
          ? firstSentence(m.description)
          : describeCapabilities({ contextWindow: context, supportsVision: vision, effort, supportsTools: tools }),
      family: familyOf(m.id),
      contextWindow: context,
      maxOutputTokens: output,
      supportsTools: tools,
      supportsVision: vision,
      supportsWebSearch: false,
      effort,
      featured: false,
      cheap: isFastTier(m.id),
      createdAt: typeof m.created === 'number' ? m.created * 1000 : null,
      pricing
    };
  }

  async *streamText(req: StreamRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const modelId = req.model.ref.modelId;
    const maxTokens = Math.min(req.model.maxOutputTokens, 64_000);
    const effort = req.effort && req.model.effort ? OPENAI_EFFORT[req.effort] : undefined;
    const build = (withStreamOptions: boolean): Record<string, unknown> => ({
      model: modelId,
      stream: true,
      messages: toChatMessages(req.system, req.messages, req.model.supportsVision),
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
      ...(effort && this.kind === 'openai' ? { reasoning_effort: effort } : {}),
      ...(effort && this.kind === 'openrouter' ? { reasoning: { effort } } : {}),
      ...(this.kind === 'openai' ? { prompt_cache_key: req.cacheKey } : {})
    });

    let response: Response;
    const url = joinUrl(this.base, 'chat/completions');
    try {
      response = await request({
        url,
        headers: this.headers(),
        body: build(!this.noStreamOptions.has(modelId)),
        signal,
        timeoutMs: 120_000
      });
    } catch (error) {
      // Some OpenAI-compatible servers reject stream_options; retry once without it.
      if (error instanceof ProviderError && error.code === 'bad_request' && /stream_options/i.test(error.message)) {
        this.noStreamOptions.add(modelId);
        response = await request({ url, headers: this.headers(), body: build(false), signal, timeoutMs: 120_000 });
      } else {
        throw error;
      }
    }
    if (!response.body) throw new ProviderError('server', 'The provider returned an empty stream.');

    let text = '';
    let thinking = '';
    const calls: Array<{ id: string; name: string; args: string }> = [];
    let finish: string | null = null;
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

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
        | { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
        | undefined;
      if (u) {
        const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
        usage.inputTokens = Math.max(0, (u.prompt_tokens ?? 0) - cached);
        usage.cacheReadTokens = cached;
        usage.outputTokens = u.completion_tokens ?? 0;
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
    yield { type: 'usage', usage };
    yield { type: 'finish', reason: calls.length > 0 && finish !== 'length' ? 'tool_use' : mapFinish(finish) };
  }
}

function firstSentence(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const match = /^(.{20,140}?[.!?])(\s|$)/.exec(clean);
  return match?.[1] ?? (clean.length > 140 ? `${clean.slice(0, 137)}…` : clean);
}
