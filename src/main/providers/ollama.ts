import { randomUUID } from 'node:crypto';
import type { EffortLevel, Usage } from '@shared/schemas/common';
import type { LlmMessage } from '@shared/schemas/messages';
import type { CustomModel, ModelInfo } from '@shared/schemas/models';
import { isLocalUrl } from '@shared/privacy';
import { arrangeModels, describeCapabilities, effortSupport, familyOf, isFastTier } from './catalog';
import { ProviderError } from './errors';
import { hostOf, joinUrl, request, requestJson } from './http';
import { firstByteTimeout } from './localServer';
import { parseNdjson } from './sse';
import { extractTextToolCalls, refusesTools, textToolPrompt, toolCallMarkup, ToolMarkupFilter, toolResponseMarkup } from './textToolCalls';
import type { FinishReason, LLMProvider, ProviderConnection, StreamEvent, StreamRequest } from './types';

interface TagModel {
  name: string;
  modified_at?: string;
  /** Set when the server does not run the model itself but passes requests on to a hosted one. */
  remote_host?: string;
}

/** A model the server passes on to a hosted one: it says so, or its tag does ("…-cloud", ":cloud"). */
function isHosted(tag: TagModel): boolean {
  return (typeof tag.remote_host === 'string' && tag.remote_host.length > 0) || /[:-]cloud$/i.test(tag.name);
}

interface ShowResponse {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
}

type OllamaMessage =
  | { role: 'system' | 'user'; content: string; images?: string[] }
  | { role: 'assistant'; content: string; tool_calls?: Array<{ function: { name: string; arguments: unknown } }> }
  | { role: 'tool'; content: string; tool_name: string };

/**
 * Context we request by default; Ollama's own default is too small for an agent's prompt, and
 * a model's full trained length can take more memory than the computer has. A size set for
 * the model in Settings → Models replaces it.
 */
const DEFAULT_NUM_CTX = 32_768;

/**
 * Ollama models that accept named reasoning levels for `think`; the rest take
 * a boolean. This mirrors Ollama's documented behavior for its gpt-oss models.
 */
const LEVELED_THINKING = /gpt-oss/i;

/**
 * Converts neutral history into Ollama chat messages. With `textTools`, for a model that writes
 * its tool calls as text, earlier calls go back as the markup it was taught and their results as
 * user messages, since such a model's template has no tool role.
 */
export function toOllamaMessages(system: string, messages: LlmMessage[], vision: boolean, textTools = false): OllamaMessage[] {
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
      if (textTools) {
        const written = calls.map((call) => toolCallMarkup(call.function.name, call.function.arguments));
        out.push({ role: 'assistant', content: [content, ...written].filter((part) => part.length > 0).join('\n\n') });
        continue;
      }
      out.push({ role: 'assistant', content, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
      continue;
    }
    const texts: string[] = [];
    const images: string[] = [];
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        const text = block.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');
        const name = names.get(block.toolUseId) ?? 'tool';
        if (textTools) texts.push(toolResponseMarkup(name, text || '(no output)', block.isError));
        else out.push({ role: 'tool', content: (block.isError ? 'Error: ' : '') + (text || '(no output)'), tool_name: name });
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
  /** Context sizes the user set per model (Settings → Models → Custom model IDs). */
  private readonly sizes: Map<string, number>;
  /** How the user said each model calls tools (Settings → Models → Custom model IDs). */
  private readonly toolFormats: Map<string, 'native' | 'text'>;
  /** Models the server passes on to a hosted one, as the last model list said. */
  private readonly hosted = new Set<string>();
  /** Models that refused the tools parameter; they get their tools in the prompt from then on. */
  private readonly textTools = new Set<string>();

  constructor(connection: ProviderConnection, customModels: CustomModel[] = []) {
    this.id = connection.id;
    this.base = connection.baseUrl ?? 'http://localhost:11434';
    this.sizes = new Map(customModels.flatMap((m) => (m.contextWindow !== undefined ? [[m.id, m.contextWindow] as const] : [])));
    this.toolFormats = new Map(customModels.flatMap((m) => (m.toolFormat !== undefined ? [[m.id, m.toolFormat] as const] : [])));
  }

  /** Whether this model runs on a server of the user's own, rather than passed on to a hosted one. */
  private isLocalModel(name: string): boolean {
    return isLocalUrl(this.base) && !this.hosted.has(name) && !isHosted({ name });
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
    const hosted = new Set((tags.models ?? []).filter(isHosted).map((m) => m.name));
    for (const name of hosted) this.hosted.add(name);
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
        infos.push(this.toModelInfo(name, show, modified.get(name), hosted.has(name)));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    return arrangeModels(infos);
  }

  private toModelInfo(name: string, show: ShowResponse, modifiedAt: number | undefined, hosted: boolean): ModelInfo {
    const caps = show.capabilities ?? [];
    const ctxEntry = Object.entries(show.model_info ?? {}).find(([k, v]) => k.endsWith('.context_length') && typeof v === 'number');
    const trained = (ctxEntry?.[1] as number | undefined) ?? 8192;
    // The window is what Graft asks the server to hold (num_ctx below), because that is all the server keeps:
    // it drops the oldest messages beyond it without saying so. Measuring against the trained length
    // would compact long after the model had stopped seeing the start of the conversation.
    // A hosted model costs this computer no memory, so it gets its whole window.
    const contextWindow = Math.min(trained, this.sizes.get(name) ?? (hosted ? trained : DEFAULT_NUM_CTX));
    // A model on this computer without native tool calls is taught to write them as text.
    const toolFormat = this.toolFormats.get(name) ?? (this.isLocalModel(name) && !caps.includes('tools') ? 'text' : undefined);
    const tools = toolFormat === 'text' || caps.includes('tools');
    const vision = caps.includes('vision');
    const effort = caps.includes('thinking')
      ? effortSupport(LEVELED_THINKING.test(name) ? ['low', 'medium', 'high', 'taproot'] : ['low', 'high', 'taproot'])
      : null;
    return {
      ref: { providerId: this.id, modelId: name },
      label: name,
      description: describeCapabilities({ contextWindow, of: trained, supportsVision: vision, effort, supportsTools: tools }),
      family: familyOf(name),
      contextWindow,
      maxOutputTokens: Math.min(contextWindow, 32_768),
      supportsTools: tools,
      ...(toolFormat === 'text' ? { toolFormat } : {}),
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
    const offered = req.tools.length > 0 && req.model.supportsTools;
    let textMode = req.model.toolFormat === 'text' || this.textTools.has(modelId);
    const send = async (): Promise<Response> => {
      try {
        return await request({
          url: joinUrl(this.base, 'api/chat'),
          body: {
            model: modelId,
            stream: true,
            messages: toOllamaMessages(
              textMode && offered ? `${req.system}\n\n${textToolPrompt(req.tools)}` : req.system,
              req.messages,
              req.model.supportsVision,
              textMode
            ),
            ...(offered && !textMode
              ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
              : {}),
            ...(think !== undefined ? { think } : {}),
            options: { num_ctx: req.model.contextWindow },
            // Ollama unloads a model after five idle minutes, and loading it again costs the next turn a long wait.
            keep_alive: '30m'
          },
          signal,
          timeoutMs: firstByteTimeout(this.base, 300_000)
        });
      } catch (error) {
        throw this.unreachable(error);
      }
    };
    let response: Response;
    try {
      response = await send();
    } catch (error) {
      // A model without native tool calls may refuse the tools parameter: ask once more with them in the prompt.
      if (textMode || !offered || !refusesTools(error)) throw error;
      this.textTools.add(modelId);
      textMode = true;
      response = await send();
    }
    if (!response.body) throw new ProviderError('server', 'Ollama returned an empty stream.');
    // Calls written as text are read from the whole reply: in text mode always, and from a model on this
    // computer that may write them as text even when it was offered native tools. The markup is held back
    // while it streams so it never shows.
    const recover = offered && (textMode || this.isLocalModel(modelId));
    const filter = recover ? new ToolMarkupFilter() : null;

    let text = '';
    let thinking = '';
    const calls: Array<{ name: string; args: unknown }> = [];
    let doneReason: string | undefined;
    let completed = false;
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
        const shown = filter ? filter.push(m.content) : m.content;
        if (shown.length > 0) yield { type: 'text-delta', text: shown };
      }
      for (const call of m?.tool_calls ?? []) {
        if (call.function?.name) calls.push({ name: call.function.name, args: call.function.arguments ?? {} });
      }
      if (chunk.done === true) {
        completed = true;
        doneReason = chunk.done_reason;
        usage.inputTokens = chunk.prompt_eval_count ?? 0;
        usage.outputTokens = chunk.eval_count ?? 0;
        break;
      }
    }
    if (signal.aborted) throw new ProviderError('aborted', 'Request cancelled.');
    // A closed connection is not a completed reply. The loop retains text
    // deltas on failure, but tools are emitted only after Ollama's done:true.
    if (!completed) throw new ProviderError('network', 'The reply stopped before it was complete. Ollama did not confirm completion.');
    // The text block replaces what the deltas showed, so what the filter still holds is never sent as a
    // delta: the block carries the reply without the markup that was read as calls.
    if (recover && (textMode || calls.length === 0)) {
      const read = extractTextToolCalls(text, new Map(req.tools.map((t) => [t.name, t.inputSchema])));
      text = read.text;
      calls.push(...read.calls.map((call) => ({ name: call.name, args: call.input })));
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
