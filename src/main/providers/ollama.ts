import { randomUUID } from 'node:crypto';
import type { EffortLevel, Usage } from '@shared/schemas/common';
import type { LlmMessage } from '@shared/schemas/messages';
import type { ModelInfo } from '@shared/schemas/models';
import { arrangeModels, describeCapabilities, effortSupport, familyOf, isFastTier } from './catalog';
import { ProviderError } from './errors';
import { hostOf, joinUrl, request, requestJson } from './http';
import { parseNdjson } from './sse';
import type { FinishReason, LLMProvider, ProviderConnection, StreamEvent, StreamRequest } from './types';

interface TagModel {
  name: string;
  modified_at?: string;
}

interface ShowResponse {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
}

type OllamaMessage =
  | { role: 'system' | 'user'; content: string; images?: string[] }
  | { role: 'assistant'; content: string; tool_calls?: Array<{ function: { name: string; arguments: unknown } }> }
  | { role: 'tool'; content: string; tool_name: string };

/** Context we request by default; Ollama's own default is too small for an agent's prompt. */
const DEFAULT_NUM_CTX = 32_768;

/**
 * Ollama models that accept named reasoning levels for `think`; the rest take
 * a boolean. This mirrors Ollama's documented behavior for its gpt-oss models.
 */
const LEVELED_THINKING = /gpt-oss/i;

export function toOllamaMessages(system: string, messages: LlmMessage[], vision: boolean): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: 'system', content: system }];
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      let content = '';
      const calls: Array<{ function: { name: string; arguments: unknown } }> = [];
      for (const block of message.content) {
        if (block.type === 'text') content += block.text;
        if (block.type === 'tool_use') {
          names.set(block.id, block.name);
          calls.push({ function: { name: block.name, arguments: typeof block.input === 'object' && block.input !== null ? block.input : {} } });
        }
      }
      if (content.length === 0 && calls.length === 0) continue;
      out.push({ role: 'assistant', content, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
      continue;
    }
    const texts: string[] = [];
    const images: string[] = [];
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        const text = block.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');
        out.push({ role: 'tool', content: (block.isError ? 'Error: ' : '') + (text || '(no output)'), tool_name: names.get(block.toolUseId) ?? 'tool' });
      } else if (block.type === 'text' && block.text.length > 0) {
        texts.push(block.text);
      } else if (block.type === 'image') {
        if (vision) images.push(block.data);
        else texts.push('[An image was attached, but this model cannot view images.]');
      }
    }
    if (texts.length > 0 || images.length > 0) {
      out.push({ role: 'user', content: texts.join('\n\n'), ...(images.length > 0 ? { images } : {}) });
    }
  }
  return out;
}

function thinkParam(modelId: string, effort: EffortLevel | null): boolean | 'low' | 'medium' | 'high' | undefined {
  if (!effort) return undefined;
  if (LEVELED_THINKING.test(modelId)) return effort === 'low' ? 'low' : effort === 'medium' ? 'medium' : 'high';
  return effort !== 'low';
}

export class OllamaProvider implements LLMProvider {
  readonly kind = 'ollama' as const;
  readonly id: string;
  private readonly base: string;

  constructor(connection: ProviderConnection) {
    this.id = connection.id;
    this.base = connection.baseUrl ?? 'http://localhost:11434';
  }

  private unreachable(error: unknown): unknown {
    if (error instanceof ProviderError && error.code === 'network' && !error.retryable) {
      return new ProviderError('network', `Ollama isn't reachable at ${hostOf(this.base)}. Start Ollama or check the URL.`, {
        retryable: false,
        cause: error
      });
    }
    return error;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    let tags: { models?: TagModel[] };
    try {
      tags = await requestJson<{ models?: TagModel[] }>({ url: joinUrl(this.base, 'api/tags'), ...(signal ? { signal } : {}), timeoutMs: 10_000 });
    } catch (error) {
      throw this.unreachable(error);
    }
    const names = (tags.models ?? []).map((m) => m.name).slice(0, 80);
    const modified = new Map((tags.models ?? []).map((m) => [m.name, m.modified_at ? Date.parse(m.modified_at) : NaN]));
    const infos: ModelInfo[] = [];
    const queue = [...names];
    const worker = async (): Promise<void> => {
      for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
        const show = await requestJson<ShowResponse>({
          url: joinUrl(this.base, 'api/show'),
          body: { model: name },
          ...(signal ? { signal } : {}),
          timeoutMs: 15_000
        });
        infos.push(this.toModelInfo(name, show, modified.get(name)));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    return arrangeModels(infos);
  }

  private toModelInfo(name: string, show: ShowResponse, modifiedAt: number | undefined): ModelInfo {
    const caps = show.capabilities ?? [];
    const ctxEntry = Object.entries(show.model_info ?? {}).find(([k, v]) => k.endsWith('.context_length') && typeof v === 'number');
    const contextWindow = (ctxEntry?.[1] as number | undefined) ?? 8192;
    const tools = caps.includes('tools');
    const vision = caps.includes('vision');
    const effort = caps.includes('thinking')
      ? effortSupport(LEVELED_THINKING.test(name) ? ['low', 'medium', 'high', 'taproot'] : ['low', 'high', 'taproot'])
      : null;
    return {
      ref: { providerId: this.id, modelId: name },
      label: name,
      description: describeCapabilities({ contextWindow, supportsVision: vision, effort, supportsTools: tools }),
      family: familyOf(name),
      contextWindow,
      maxOutputTokens: Math.min(contextWindow, 32_768),
      supportsTools: tools,
      supportsVision: vision,
      supportsWebSearch: false,
      effort,
      featured: false,
      cheap: isFastTier(name),
      createdAt: modifiedAt !== undefined && !Number.isNaN(modifiedAt) ? modifiedAt : null,
      pricing: null
    };
  }

  async *streamText(req: StreamRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const modelId = req.model.ref.modelId;
    const think = req.model.effort ? thinkParam(modelId, req.effort) : undefined;
    let response: Response;
    try {
      response = await request({
        url: joinUrl(this.base, 'api/chat'),
        body: {
          model: modelId,
          stream: true,
          messages: toOllamaMessages(req.system, req.messages, req.model.supportsVision),
          ...(req.tools.length > 0 && req.model.supportsTools
            ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
            : {}),
          ...(think !== undefined ? { think } : {}),
          options: { num_ctx: Math.min(req.model.contextWindow, DEFAULT_NUM_CTX) }
        },
        signal,
        timeoutMs: 300_000
      });
    } catch (error) {
      throw this.unreachable(error);
    }
    if (!response.body) throw new ProviderError('server', 'Ollama returned an empty stream.');

    let text = '';
    let thinking = '';
    const calls: Array<{ name: string; args: unknown }> = [];
    let doneReason: string | undefined;
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for await (const raw of parseNdjson(response.body)) {
      if (signal.aborted) throw new ProviderError('aborted', 'Request cancelled.');
      const chunk = raw as {
        error?: string;
        message?: { content?: string; thinking?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> };
        done?: boolean;
        done_reason?: string;
        prompt_eval_count?: number;
        eval_count?: number;
      };
      if (chunk.error) throw new ProviderError('server', `Ollama: ${chunk.error}`, { retryable: false });
      const m = chunk.message;
      if (m?.thinking) {
        thinking += m.thinking;
        yield { type: 'thinking-delta', text: m.thinking };
      }
      if (m?.content) {
        text += m.content;
        yield { type: 'text-delta', text: m.content };
      }
      for (const call of m?.tool_calls ?? []) {
        if (call.function?.name) calls.push({ name: call.function.name, args: call.function.arguments ?? {} });
      }
      if (chunk.done) {
        doneReason = chunk.done_reason;
        usage.inputTokens = chunk.prompt_eval_count ?? 0;
        usage.outputTokens = chunk.eval_count ?? 0;
      }
    }
    if (thinking.length > 0) yield { type: 'block', block: { type: 'thinking', text: thinking, display: 'summary', origin: 'ollama' } };
    if (text.length > 0) yield { type: 'block', block: { type: 'text', text } };
    for (const call of calls) {
      yield { type: 'block', block: { type: 'tool_use', id: `call_${randomUUID().slice(0, 8)}`, name: call.name, input: call.args } };
    }
    yield { type: 'usage', usage };
    const reason: FinishReason = calls.length > 0 ? 'tool_use' : doneReason === 'length' ? 'max_tokens' : 'stop';
    yield { type: 'finish', reason };
  }
}
