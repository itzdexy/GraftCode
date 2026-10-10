import { randomUUID } from 'node:crypto';
import type { Usage } from '@shared/schemas/common';
import type { LlmMessage } from '@shared/schemas/messages';
import type { ModelInfo } from '@shared/schemas/models';
import { arrangeModels, describeCapabilities, effortSupport, familyOf, isFastTier, labelFromId, THINKING_BUDGETS } from './catalog';
import { ProviderError } from './errors';
import { joinUrl, request, requestJson } from './http';
import { parseSse } from './sse';
import type { FinishReason, LLMProvider, ProviderConnection, StreamEvent, StreamRequest } from './types';

interface GeminiModel {
  name: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
  thinking?: boolean;
}

type GeminiPart =
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: unknown; id?: string }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown>; id?: string } };

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

const NON_TEXT_MODELS = /(embedding|aqa|imagen|tts|veo|learnlm|live|native-audio|image-generation|robotics)/i;
/** Largest thinking budget accepted across current thinking models. */
const MAX_BUDGET = 24_576;

export function toGeminiContents(messages: LlmMessage[], vision: boolean): GeminiContent[] {
  const names = new Map<string, string>();
  const providerIds = new Map<string, string>();
  const out: GeminiContent[] = [];
  for (const message of messages) {
    const parts: GeminiPart[] = [];
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          if (block.text.length > 0) parts.push({ text: block.text });
          break;
        case 'image':
          parts.push(
            vision
              ? { inlineData: { mimeType: block.mediaType, data: block.data } }
              : { text: '[An image was attached, but this model cannot view images.]' }
          );
          break;
        case 'tool_use': {
          names.set(block.id, block.name);
          const geminiId = block.meta?.geminiId;
          if (geminiId) providerIds.set(block.id, geminiId);
          const part: GeminiPart = {
            functionCall: { name: block.name, args: typeof block.input === 'object' && block.input !== null ? block.input : {}, ...(geminiId ? { id: geminiId } : {}) },
            ...(block.meta?.thoughtSignature ? { thoughtSignature: block.meta.thoughtSignature } : {})
          };
          parts.push(part);
          break;
        }
        case 'tool_result': {
          const text = block.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');
          const geminiId = providerIds.get(block.toolUseId);
          parts.push({
            functionResponse: {
              name: names.get(block.toolUseId) ?? 'tool',
              response: block.isError ? { error: text } : { output: text },
              ...(geminiId ? { id: geminiId } : {})
            }
          });
          break;
        }
        default:
          break;
      }
    }
    if (parts.length > 0) out.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }
  return out;
}

function mapFinish(reason: string | undefined, hasCalls: boolean): FinishReason {
  if (hasCalls && (reason === undefined || reason === 'STOP')) return 'tool_use';
  switch (reason) {
    case undefined:
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'refusal';
    default:
      return 'other';
  }
}

export class GeminiProvider implements LLMProvider {
  readonly kind = 'gemini' as const;
  readonly id: string;
  private readonly base: string;
  private readonly apiKey: string;

  constructor(connection: ProviderConnection) {
    if (!connection.apiKey) throw new ProviderError('auth', 'An API key is required.', { retryable: false });
    this.id = connection.id;
    this.apiKey = connection.apiKey;
    this.base = connection.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  }

  private remap(error: unknown): unknown {
    if (error instanceof ProviderError && error.code === 'bad_request' && /api key/i.test(error.message)) {
      return new ProviderError('auth', 'The API key was rejected.', { status: error.status, retryable: false, cause: error });
    }
    return error;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const all: GeminiModel[] = [];
    let pageToken: string | undefined;
    try {
      do {
        const url = joinUrl(this.base, `models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
        const page = await requestJson<{ models?: GeminiModel[]; nextPageToken?: string }>({
          url,
          headers: { 'x-goog-api-key': this.apiKey },
          ...(signal ? { signal } : {})
        });
        all.push(...(page.models ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (error) {
      throw this.remap(error);
    }
    const models = all
      .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent') && !NON_TEXT_MODELS.test(m.name))
      .map((m): ModelInfo => {
        const id = m.name.replace(/^models\//, '');
        const effort = m.thinking ? effortSupport(['low', 'medium', 'high', 'extra', 'max', 'taproot']) : null;
        const contextWindow = m.inputTokenLimit ?? 1_048_576;
        return {
          ref: { providerId: this.id, modelId: id },
          label: m.displayName ?? labelFromId(id),
          description: describeCapabilities({ contextWindow, supportsVision: true, effort, supportsTools: true }),
          family: familyOf(id),
          contextWindow,
          maxOutputTokens: m.outputTokenLimit ?? 8192,
          supportsTools: true,
          supportsVision: true,
          supportsWebSearch: false,
          effort,
          featured: false,
          cheap: isFastTier(id),
          createdAt: null,
          pricing: null
        };
      });
    return arrangeModels(models);
  }

  async *streamText(req: StreamRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const modelId = req.model.ref.modelId;
    const thinking =
      req.model.effort && req.effort
        ? { includeThoughts: true, thinkingBudget: Math.min(MAX_BUDGET, Math.max(1024, THINKING_BUDGETS[req.effort])) }
        : undefined;
    const body = {
      contents: toGeminiContents(req.messages, req.model.supportsVision),
      systemInstruction: { parts: [{ text: req.system }] },
      ...(req.tools.length > 0
        ? {
            tools: [
              {
                functionDeclarations: req.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parametersJsonSchema: t.inputSchema
                }))
              }
            ],
            toolConfig: { functionCallingConfig: { mode: 'AUTO' } }
          }
        : {}),
      generationConfig: {
        maxOutputTokens: Math.min(req.model.maxOutputTokens, 65_536),
        ...(thinking ? { thinkingConfig: thinking } : {})
      }
    };
    let response: Response;
    try {
      response = await request({
        url: joinUrl(this.base, `models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`),
        headers: { 'x-goog-api-key': this.apiKey },
        body,
        signal,
        timeoutMs: 120_000
      });
    } catch (error) {
      throw this.remap(error);
    }
    if (!response.body) throw new ProviderError('server', 'The provider returned an empty stream.');

    let text = '';
    let thought = '';
    const calls: Array<{ name: string; args: unknown; id: string | undefined; signature: string | undefined }> = [];
    let finishReason: string | undefined;
    let blocked = false;
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    for await (const msg of parseSse(response.body)) {
      if (signal.aborted) throw new ProviderError('aborted', 'Request cancelled.');
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(msg.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const err = chunk.error as { message?: string; code?: number } | undefined;
      if (err) {
        const code = err.code ?? 0;
        throw new ProviderError(code === 429 ? 'rate_limit' : code >= 500 ? 'server' : 'unknown', err.message ?? 'Provider error', {
          retryable: code === 429 || code >= 500
        });
      }
      if ((chunk.promptFeedback as { blockReason?: string } | undefined)?.blockReason) blocked = true;
      const cand = (chunk.candidates as Array<Record<string, unknown>> | undefined)?.[0];
      const parts = (cand?.content as { parts?: Array<Record<string, unknown>> } | undefined)?.parts ?? [];
      for (const part of parts) {
        if (typeof part.text === 'string') {
          if (part.thought === true) {
            thought += part.text;
            yield { type: 'thinking-delta', text: part.text };
          } else if (part.text.length > 0) {
            text += part.text;
            yield { type: 'text-delta', text: part.text };
          }
        } else if (part.functionCall && typeof part.functionCall === 'object') {
          const fc = part.functionCall as { name?: string; args?: unknown; id?: string };
          calls.push({
            name: fc.name ?? 'unknown',
            args: fc.args ?? {},
            id: typeof fc.id === 'string' ? fc.id : undefined,
            signature: typeof part.thoughtSignature === 'string' ? part.thoughtSignature : undefined
          });
        }
      }
      if (typeof cand?.finishReason === 'string') finishReason = cand.finishReason;
      const u = chunk.usageMetadata as
        | { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number }
        | undefined;
      if (u) {
        const cached = u.cachedContentTokenCount ?? 0;
        usage.inputTokens = Math.max(0, (u.promptTokenCount ?? 0) - cached);
        usage.cacheReadTokens = cached;
        usage.outputTokens = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
      }
    }

    if (signal.aborted) throw new ProviderError('aborted', 'Request cancelled.');
    // The end of the connection is not the end of the reply: only a finish reason is, or a prompt the
    // provider refused. What was streamed stays visible; the function calls of a reply nobody confirmed
    // are never offered to the loop.
    if (finishReason === undefined && !blocked) {
      throw new ProviderError('network', 'The reply stopped before it was complete. Gemini did not send a finish reason.');
    }

    if (thought.length > 0) yield { type: 'block', block: { type: 'thinking', text: thought, display: 'summary', origin: 'gemini' } };
    if (text.length > 0) yield { type: 'block', block: { type: 'text', text } };
    for (const call of calls) {
      const meta: Record<string, string> = {};
      if (call.id) meta.geminiId = call.id;
      if (call.signature) meta.thoughtSignature = call.signature;
      yield {
        type: 'block',
        block: {
          type: 'tool_use',
          id: call.id ?? `call_${randomUUID().slice(0, 8)}`,
          name: call.name,
          input: call.args,
          ...(Object.keys(meta).length > 0 ? { meta } : {})
        }
      };
    }
    yield { type: 'usage', usage };
    yield { type: 'finish', reason: blocked ? 'refusal' : mapFinish(finishReason, calls.length > 0) };
  }
}
