import type { EffortLevel, ProviderKind, Usage } from '@shared/schemas/common';
import type { ContentBlock, LlmMessage } from '@shared/schemas/messages';
import type { ModelInfo } from '@shared/schemas/models';

/** A tool as offered to the model: JSON Schema input, provider-neutral. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Data-use requests sent with a model call. Only some APIs take them:
 * OpenRouter routes around providers that don't comply, OpenAI gets
 * store: false. Others follow their own terms (see shared/privacy.ts).
 */
export interface RequestPrivacy {
  /** Don't use providers that train on or store prompts. */
  noTraining: boolean;
  /** Incognito: only endpoints that keep nothing at all (OpenRouter's zero-data-retention routing). */
  zeroRetention: boolean;
}

export interface StreamRequest {
  model: ModelInfo;
  system: string;
  messages: LlmMessage[];
  tools: ToolSpec[];
  /** null when the model has no effort control. */
  effort: EffortLevel | null;
  /** What to ask the provider about keeping and training on this request. */
  privacy: RequestPrivacy;
  /** Provider-side web search, only honored where the model supports it. */
  webSearch: boolean;
  /** Stable key for provider-side prompt caching (the session id). */
  cacheKey: string;
}

export type FinishReason = 'stop' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause' | 'context_window' | 'other';

export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  /** A finished content block, emitted in order; the loop builds the assistant message from these. */
  | { type: 'block'; block: ContentBlock }
  /** `costUsd` is what the provider says it charged, when it reports that. */
  | { type: 'usage'; usage: Usage; costUsd?: number }
  | { type: 'finish'; reason: FinishReason; detail?: string };

export interface LLMProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  /** Live model list (a real network call) — also used to verify credentials. */
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  /** Streams one model response. Must honor `signal` and throw ProviderError on failure. */
  streamText(request: StreamRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
}

export interface ProviderConnection {
  id: string;
  kind: ProviderKind;
  /** Catalog preset (null for a custom endpoint); selects model metadata. */
  preset: string | null;
  apiKey: string | null;
  baseUrl: string | null;
}
