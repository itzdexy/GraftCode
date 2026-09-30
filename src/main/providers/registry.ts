import { GraftError } from '@shared/errors';
import type { ModelRef, ProviderKind } from '@shared/schemas/common';
import type { ModelInfo, ProviderSummary, VerifyResult } from '@shared/schemas/models';
import { PROVIDER_KIND_INFO } from '@shared/providerKinds';
import type { ProviderRecord, ProvidersRepo } from '../db/providersRepo';
import type { KeyStore } from '../secrets/keyStore';
import { AnthropicProvider } from './anthropic';
import { ProviderError } from './errors';
import { GeminiProvider } from './gemini';
import { OllamaProvider } from './ollama';
import { OpenAiChatProvider } from './openaiChat';
import type { LLMProvider, ProviderConnection } from './types';

export type ProviderFactory = (connection: ProviderConnection, record: Pick<ProviderRecord, 'customModels'>) => LLMProvider;

export const createProvider: ProviderFactory = (connection, record) => {
  switch (connection.kind) {
    case 'anthropic':
      return new AnthropicProvider(connection);
    case 'gemini':
      return new GeminiProvider(connection);
    case 'ollama':
      return new OllamaProvider(connection);
    case 'openai':
    case 'openrouter':
    case 'openai-compatible':
      return new OpenAiChatProvider({ ...connection, kind: connection.kind }, record.customModels);
  }
};

const MODEL_CACHE_MS = 10 * 60_000;

export interface ProviderModels {
  providerId: string;
  models: ModelInfo[];
  error: { code: string; message: string } | null;
}

/** Normalizes a user-entered base URL: trims, drops trailing slashes, requires http(s). */
export function normalizeBaseUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new GraftError('invalid_base_url', 'Enter a full URL, for example http://localhost:8000/v1.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new GraftError('invalid_base_url', 'The base URL must start with http:// or https://.');
  }
  return trimmed;
}

/**
 * Owns provider instances (rebuilt when their key or URL changes) and the
 * model catalog cache. Keys are read from the KeyStore here and nowhere else.
 */
export class ProviderRegistry {
  private readonly instances = new Map<string, { fingerprint: string; provider: LLMProvider }>();
  private readonly cache = new Map<string, { at: number; models: ModelInfo[] }>();

  constructor(
    private readonly repo: ProvidersRepo,
    private readonly keys: KeyStore,
    private readonly factory: ProviderFactory = createProvider
  ) {}

  summaries(): ProviderSummary[] {
    return this.repo.list().map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      baseUrl: r.baseUrl,
      hasKey: this.keys.has(r.id),
      enabled: r.enabled,
      isDefault: r.isDefault,
      createdAt: r.createdAt,
      customModels: r.customModels
    }));
  }

  get(providerId: string): LLMProvider {
    const record = this.repo.require(providerId);
    const key = PROVIDER_KIND_INFO[record.kind].key === 'none' ? null : this.keys.get(providerId);
    if (PROVIDER_KIND_INFO[record.kind].key === 'required' && !key) {
      throw new GraftError('missing_key', `${record.label} has no API key. Add one in Settings → Providers.`);
    }
    const fingerprint = JSON.stringify([record.kind, record.baseUrl, key ? key.length : 0, key?.slice(-6) ?? '', record.customModels]);
    const cached = this.instances.get(providerId);
    if (cached && cached.fingerprint === fingerprint) return cached.provider;
    const provider = this.factory({ id: record.id, kind: record.kind, apiKey: key, baseUrl: record.baseUrl }, record);
    this.instances.set(providerId, { fingerprint, provider });
    return provider;
  }

  invalidate(providerId: string): void {
    this.instances.delete(providerId);
    this.cache.delete(providerId);
  }

  async listModels(providerId: string, options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<ModelInfo[]> {
    const hit = this.cache.get(providerId);
    if (hit && !options.refresh && Date.now() - hit.at < MODEL_CACHE_MS) return hit.models;
    const models = await this.get(providerId).listModels(options.signal);
    this.cache.set(providerId, { at: Date.now(), models });
    return models;
  }

  /** Models for every enabled provider; one failing provider doesn't hide the others. */
  async allModels(options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<ProviderModels[]> {
    const records = this.repo.list().filter((r) => r.enabled);
    return Promise.all(
      records.map(async (r): Promise<ProviderModels> => {
        try {
          return { providerId: r.id, models: await this.listModels(r.id, options), error: null };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const code = error instanceof ProviderError || error instanceof GraftError ? error.code : 'unknown';
          return { providerId: r.id, models: [], error: { code, message } };
        }
      })
    );
  }

  async resolveModel(ref: ModelRef, signal?: AbortSignal): Promise<ModelInfo> {
    const models = await this.listModels(ref.providerId, signal ? { signal } : {});
    const found = models.find((m) => m.ref.modelId === ref.modelId);
    if (found) return found;
    throw new GraftError('model_not_found', `The model "${ref.modelId}" isn't available from this provider anymore. Pick another model.`);
  }

  /** Verifies unsaved credentials with a real list-models call. Never throws. */
  async verifyDraft(
    draft: { kind: ProviderKind; baseUrl: string | null; apiKey: string | null },
    signal?: AbortSignal
  ): Promise<VerifyResult> {
    try {
      const provider = this.factory(
        { id: 'verify', kind: draft.kind, apiKey: draft.apiKey, baseUrl: normalizeBaseUrl(draft.baseUrl) },
        { customModels: [] }
      );
      const models = await provider.listModels(signal);
      return { ok: true, modelCount: models.length };
    } catch (error) {
      if (error instanceof ProviderError) {
        const code = error.code === 'not_found' ? 'bad_base_url' : error.code;
        const message =
          error.code === 'not_found'
            ? `Nothing answered at that address (404). Check the base URL.`
            : error.message;
        return { ok: false, code, message };
      }
      if (error instanceof GraftError) return { ok: false, code: 'bad_request', message: error.message };
      return { ok: false, code: 'unknown', message: error instanceof Error ? error.message : String(error) };
    }
  }
}
