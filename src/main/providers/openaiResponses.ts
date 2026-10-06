import type { Usage } from '@shared/schemas/common';
import type { ContentBlock, LlmMessage } from '@shared/schemas/messages';
import { ProviderError } from './errors';
import { parseSse } from './sse';
import type { FinishReason, StreamEvent, StreamRequest } from './types';

/**
 * OpenAI's Responses API, which some of its models answer instead of chat
 * completions: the -pro models, the Codex models and deep research. Chat
 * completions rejects them. The conversation is stateless here (store: false),
 * so what a reasoning model thought comes back with each request, as the API
 * returned it.
 */

/** OpenAI models that only the Responses API serves, by the words in their ids. */
const RESPONSES_ONLY = /(^|[-_.])(pro|codex|deep-research)($|[-_.])/i;

export function usesResponses(modelId: string): boolean {
  return RESPONSES_ONLY.test(modelId);
}

/** The error chat completions gives for a model that only the Responses API serves. */
export function onlyInResponses(error: unknown): boolean {
  return error instanceof ProviderError && (error.code === 'not_found' || error.code === 'bad_request') && /v1\/responses|responses api/i.test(error.message);
}

export type ResponsesItem = Record<string, unknown>;

/** What is saved with an assistant message: the items the API returned, so they can be sent back. */
interface Replay {
  model: string;
  output: ResponsesItem[];
}

function replayOf(block: ContentBlock, model: string): Replay | null {
  if (block.type !== 'provider' || block.provider !== 'openai') return null;
  const raw = block.raw as Partial<Replay> | null;
  return raw && raw.model === model && Array.isArray(raw.output) ? (raw as Replay) : null;
}

function textOf(content: Array<{ type: string; text?: string }>): string {
  return content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('\n');
}

/** Converts neutral history into Responses input items. */
export function toResponsesInput(messages: LlmMessage[], vision: boolean, model: string): ResponsesItem[] {
  const out: ResponsesItem[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      // Sent back as received, with the reasoning items, so a tool loop goes on thinking where it left off.
      const saved = message.content.map((b) => replayOf(b, model)).find((r) => r !== null);
      if (saved) {
        out.push(...saved.output);
        continue;
      }
      const text = message.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text.length > 0) out.push({ role: 'assistant', content: text });
      for (const block of message.content) {
        if (block.type === 'tool_use') {
          out.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}) });
        }
      }
      continue;
    }
    const parts: ResponsesItem[] = [];
    const toolImages: ResponsesItem[] = [];
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        out.push({ type: 'function_call_output', call_id: block.toolUseId, output: (block.isError ? 'Error: ' : '') + (textOf(block.content) || '(no output)') });
        for (const c of block.content) {
          if (c.type === 'image' && vision) toolImages.push({ type: 'input_image', image_url: `data:${c.mediaType};base64,${c.data}` });
        }
      } else if (block.type === 'text' && block.text.length > 0) {
        parts.push({ type: 'input_text', text: block.text });
      } else if (block.type === 'image') {
        parts.push(
          vision ? { type: 'input_image', image_url: `data:${block.mediaType};base64,${block.data}` } : { type: 'input_text', text: '[An image was attached, but this model cannot view images.]' }
        );
      }
    }
    if (toolImages.length > 0) parts.unshift({ type: 'input_text', text: 'Images returned by the tool calls above:' }, ...toolImages);
    if (parts.length > 0) out.push({ role: 'user', content: parts });
  }
  return out;
}

export interface ResponsesOptions {
  /** The model's own wire value for the effort asked for. */
  effort: string | undefined;
  /** Ask for a summary of the reasoning to show; some accounts are not allowed one. */
  summary: boolean;
  /** Ask for the reasoning back in encrypted form, to send with the next request. */
  encrypted: boolean;
  maxTokens: number;
}

export function responsesBody(req: StreamRequest, options: ResponsesOptions): Record<string, unknown> {
  const modelId = req.model.ref.modelId;
  // A model with effort control reasons; the others (and "none") have nothing to summarize or send back.
  const reasons = req.model.effort !== null && options.effort !== 'none';
  return {
    model: modelId,
    stream: true,
    store: false,
    instructions: req.system,
    input: toResponsesInput(req.messages, req.model.supportsVision, modelId),
    ...(req.tools.length > 0 && req.model.supportsTools
      ? { tools: req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema, strict: false })) }
      : {}),
    max_output_tokens: options.maxTokens,
    ...(options.effort !== undefined || (reasons && options.summary) ? { reasoning: { ...(options.effort !== undefined ? { effort: options.effort } : {}), ...(reasons && options.summary ? { summary: 'auto' } : {}) } } : {}),
    ...(reasons && options.encrypted ? { include: ['reasoning.encrypted_content'] } : {}),
    prompt_cache_key: req.cacheKey
  };
}

/** A failure the stream announces, in the provider's own terms. */
function streamError(error: { code?: unknown; message?: unknown } | undefined): ProviderError {
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.message === 'string' && error.message.length > 0 ? error.message : 'The provider reported an error.';
  if (/context_length|context_window/i.test(code) || /context (length|window)|too long/i.test(message)) {
    return new ProviderError('context_length', `The conversation is too long for this model: ${message}`);
  }
  if (code === 'rate_limit_exceeded' || /rate limit/i.test(message)) return new ProviderError('rate_limit', `Rate limited: ${message}`);
  if (code === 'insufficient_quota') return new ProviderError('auth', `Your OpenAI account has no credit left: ${message}`, { retryable: false });
  if (/server_error|overloaded|unavailable/i.test(code)) return new ProviderError('server', `Provider error: ${message}`);
  return new ProviderError('unknown', message, { retryable: false });
}

function usageOf(raw: unknown): Usage | null {
  const u = raw as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } | undefined;
  if (!u || typeof u.input_tokens !== 'number') return null;
  // input_tokens counts every input token, cached ones included.
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  return { inputTokens: Math.max(0, u.input_tokens - cached), outputTokens: u.output_tokens ?? 0, cacheReadTokens: cached, cacheWriteTokens: 0 };
}

/** Reads a Responses API stream into the events the agent loop understands. */
export async function* readResponsesStream(body: ReadableStream<Uint8Array>, signal: AbortSignal, model: string): AsyncGenerator<StreamEvent> {
  const items: ResponsesItem[] = [];
  let text = '';
  let thinking = '';
  let usage: Usage | null = null;
  let incomplete: string | null = null;
  let refused = false;
  let fromResponse: ResponsesItem[] | null = null;
  let ended = false;

  for await (const msg of parseSse(body)) {
    if (signal.aborted) throw new ProviderError('aborted', 'Request cancelled.');
    if (msg.data === '[DONE]') break;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(msg.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof event.type === 'string' ? event.type : (msg.event ?? '');
    const delta = typeof event.delta === 'string' ? event.delta : '';
    switch (type) {
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        if (type === 'response.refusal.delta') refused = true;
        if (delta.length > 0) {
          text += delta;
          yield { type: 'text-delta', text: delta };
        }
        break;
      case 'response.reasoning_summary_part.added':
        // Summaries come in parts; keep them apart.
        if (thinking.length > 0) {
          thinking += '\n\n';
          yield { type: 'thinking-delta', text: '\n\n' };
        }
        break;
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (delta.length > 0) {
          thinking += delta;
          yield { type: 'thinking-delta', text: delta };
        }
        break;
      case 'response.output_item.done': {
        const index = typeof event.output_index === 'number' ? event.output_index : items.length;
        if (event.item && typeof event.item === 'object') items[index] = event.item as ResponsesItem;
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        ended = true;
        const response = (event.response ?? {}) as { usage?: unknown; output?: unknown; incomplete_details?: { reason?: string } };
        usage = usageOf(response.usage) ?? usage;
        if (Array.isArray(response.output)) fromResponse = response.output as ResponsesItem[];
        if (type === 'response.incomplete') incomplete = response.incomplete_details?.reason ?? 'unknown';
        break;
      }
      case 'response.failed':
        throw streamError(((event.response ?? {}) as { error?: { code?: unknown; message?: unknown } }).error);
      case 'error':
        throw streamError(event);
      default:
        break;
    }
  }
  if (!ended) throw new ProviderError('network', 'The reply stopped before it was complete.');

  const output = items.filter((item) => item !== undefined);
  const final = output.length > 0 ? output : (fromResponse ?? []);
  const calls = final.filter((item) => item.type === 'function_call');
  if (thinking.length === 0) {
    thinking = final
      .filter((item) => item.type === 'reasoning')
      .flatMap((item) => (Array.isArray(item.summary) ? (item.summary as Array<{ text?: string }>).map((part) => part.text ?? '') : []))
      .filter((part) => part.length > 0)
      .join('\n\n');
  }
  if (text.length === 0) {
    text = final
      .filter((item) => item.type === 'message')
      .flatMap((item) => (Array.isArray(item.content) ? (item.content as Array<{ type?: string; text?: string; refusal?: string }>) : []))
      .map((part) => (part.type === 'refusal' ? (part.refusal ?? '') : (part.text ?? '')))
      .join('');
  }

  if (thinking.length > 0) yield { type: 'block', block: { type: 'thinking', text: thinking, display: 'summary', origin: 'openai' } };
  // The reasoning has to go back with the next request of a tool loop, whole.
  if (final.some((item) => item.type === 'reasoning')) {
    const raw: Replay = { model, output: final };
    yield { type: 'block', block: { type: 'provider', provider: 'openai', raw, summary: '' } };
  }
  if (text.length > 0) yield { type: 'block', block: { type: 'text', text } };
  for (const call of calls) {
    const id = typeof call.call_id === 'string' ? call.call_id : typeof call.id === 'string' ? call.id : '';
    const name = typeof call.name === 'string' ? call.name : '';
    const args = typeof call.arguments === 'string' ? call.arguments : '';
    if (args.trim().length === 0) {
      yield { type: 'block', block: { type: 'tool_use', id, name, input: {} } };
      continue;
    }
    try {
      yield { type: 'block', block: { type: 'tool_use', id, name, input: JSON.parse(args) as unknown } };
    } catch {
      yield { type: 'block', block: { type: 'tool_use', id, name, input: args, meta: { invalidJson: 'true' } } };
    }
  }
  if (usage) yield { type: 'usage', usage };
  let reason: FinishReason = calls.length > 0 ? 'tool_use' : 'stop';
  if (incomplete === 'max_output_tokens') reason = 'max_tokens';
  else if (incomplete === 'content_filter' || refused) reason = 'refusal';
  else if (incomplete !== null) reason = 'other';
  yield { type: 'finish', reason };
}
