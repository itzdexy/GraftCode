import type { Usage } from '../../src/shared/schemas/common';
import type { ModelInfo } from '../../src/shared/schemas/models';
import { ProviderError } from '../../src/main/providers/errors';
import type { FinishReason, LLMProvider, StreamEvent, StreamRequest } from '../../src/main/providers/types';

/**
 * Test-only scripted provider. Each streamText call consumes the next step.
 * It is never imported by src/, so it cannot ship in a production build.
 */
export interface FakeReply {
  text?: string;
  thinking?: string;
  toolCalls?: Array<{ id?: string; name: string; input: unknown }>;
  usage?: Partial<Usage>;
  finish?: FinishReason;
  /** Delay between streamed chunks, to test interrupts mid-stream. */
  chunkDelayMs?: number;
}
export interface FakeFailure {
  error: ProviderError;
  /** Emit this much of `text` before failing (mid-stream failure). */
  partialText?: string;
  partialThinking?: string;
}
export type FakeStep = FakeReply | FakeFailure | ((request: StreamRequest) => FakeReply | FakeFailure);

export function fakeModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    ref: { providerId: 'fake', modelId: 'fake-model' },
    label: 'Fake Model',
    description: 'Scripted test model',
    family: 'fake',
    contextWindow: 100_000,
    maxOutputTokens: 8_000,
    supportsTools: true,
    supportsVision: true,
    supportsWebSearch: false,
    effort: { levels: ['low', 'medium', 'high', 'taproot'], recommended: 'medium', default: 'medium' },
    featured: true,
    cheap: false,
    createdAt: null,
    pricing: null,
    ...overrides
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ProviderError('aborted', 'Request cancelled.'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new ProviderError('aborted', 'Request cancelled.'));
      },
      { once: true }
    );
  });
}

export class FakeProvider implements LLMProvider {
  readonly id: string;
  readonly kind = 'openai-compatible' as const;
  readonly requests: StreamRequest[] = [];
  private step = 0;

  constructor(
    private readonly script: FakeStep[],
    private readonly models: ModelInfo[] = [fakeModel()],
    id = 'fake'
  ) {
    this.id = id;
  }

  get remaining(): number {
    return this.script.length - this.step;
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve(this.models);
  }

  async *streamText(request: StreamRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    this.requests.push(structuredClone(request));
    const raw = this.script[this.step++];
    if (raw === undefined) throw new Error(`FakeProvider script exhausted after ${this.step - 1} calls`);
    const step = typeof raw === 'function' ? raw(request) : raw;
    if ('error' in step) {
      if (step.partialThinking) yield { type: 'thinking-delta', text: step.partialThinking };
      if (step.partialText) yield { type: 'text-delta', text: step.partialText };
      throw step.error;
    }
    const wait = step.chunkDelayMs ?? 0;
    if (step.thinking) {
      yield { type: 'thinking-delta', text: step.thinking };
      yield { type: 'block', block: { type: 'thinking', text: step.thinking, display: 'summary', origin: 'openai-compatible' } };
    }
    if (step.text) {
      const words = step.text.split(/(?<= )/);
      for (const word of words) {
        if (wait > 0) await delay(wait, signal);
        if (signal.aborted) throw new ProviderError('aborted', 'Request cancelled.');
        yield { type: 'text-delta', text: word };
      }
      yield { type: 'block', block: { type: 'text', text: step.text } };
    }
    for (const [i, call] of (step.toolCalls ?? []).entries()) {
      yield {
        type: 'block',
        block: { type: 'tool_use', id: call.id ?? `call_${this.step}_${i}`, name: call.name, input: call.input }
      };
    }
    yield {
      type: 'usage',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, ...step.usage }
    };
    yield { type: 'finish', reason: step.finish ?? ((step.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'stop') };
  }
}
