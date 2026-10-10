import { createHash } from 'node:crypto';
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
import { modelPricing, NATIVE_PRESET, type ProviderCatalog } from './presets';
import type { LLMProvider, ProviderConnection } from './types';
import type { ModelSnapshot, ModelSnapshotStore } from './modelSnapshots';
import { withModelLifecycle } from './modelLifecycle';

export type ProviderFactory = (
  connection: ProviderConnection,
  record: Pick<ProviderRecord, 'customModels'>,
  catalog: ProviderCatalog | null
) => LLMProvider;

export const createProvider: ProviderFactory = (connection, record, catalog) => {
  switch (connection.kind) {
    case 'anthropic':
      return new AnthropicProvider(connection);
    case 'gemini':
      return new GeminiProvider(connection, catalog);
    case 'ollama':
      return new OllamaProvider(connection, record.customModels);
    case 'openai':
    case 'openrouter':
    case 'openai-compatible':
      return new OpenAiChatProvider({ ...connection, kind: connection.kind }, record.customModels, catalog);
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
  private catalogRevision = -1;
  private readonly previous = new Map<string, ModelSnapshot>();
  private readonly versions = new Map<string, number>();

  private checkCatalog(): void {
    const revision = this.catalog?.revision ?? 0;
    if (this.catalogRevision === revision) return;
    this.instances.clear();
    this.cache.clear();
    this.catalogRevision = revision;
  }

  constructor(
    private readonly repo: ProvidersRepo,
    private readonly keys: KeyStore,
    private readonly catalog: ProviderCatalog | null = null,
    private readonly factory: ProviderFactory = createProvider,
    private readonly snapshots: ModelSnapshotStore | null = null
  ) {}

  summaries(): ProviderSummary[] {
    return this.repo.list().map((r) => ({
      id: r.id,
      kind: r.kind,
      preset: r.preset,
      label: r.label,
      baseUrl: r.baseUrl,
      hasKey: this.keys.has(r.id),
      enabled: r.enabled,
      isDefault: r.isDefault,
      createdAt: r.createdAt,
      customModels: r.customModels
    }));
  }

  /** What the provider is called: its catalog name (e.g. "OpenRouter"), else the label the user gave it. */
  providerName(providerId: string): string {
    const record = this.repo.get(providerId);
    if (!record) return providerId;
    const presetName = record.preset ? this.catalog?.preset(record.preset)?.name : undefined;
    if (presetName) return presetName;
    return record.kind === 'openai-compatible' ? record.label : PROVIDER_KIND_INFO[record.kind].name;
  }

  /** Whether a provider needs a key: the catalog preset decides (local servers don't), else the kind. */
  keyRequirement(kind: ProviderKind, preset: string | null): 'required' | 'optional' | 'none' {
    const fromPreset = preset ? this.catalog?.preset(preset)?.key : undefined;
    return fromPreset ?? PROVIDER_KIND_INFO[kind].key;
  }

  get(providerId: string): LLMProvider {
    this.checkCatalog();
    const record = this.repo.require(providerId);
    const requirement = this.keyRequirement(record.kind, record.preset);
    const key = requirement === 'none' ? null : this.keys.get(providerId);
    if (requirement === 'required' && !key) {
      throw new GraftError('missing_key', `${record.label} has no API key. Add one in Settings → Providers.`);
    }
    const fingerprint = JSON.stringify([record.kind, record.preset, record.baseUrl, key ? createHash('sha256').update(key).digest('hex') : null, record.customModels]);
    const cached = this.instances.get(providerId);
    if (cached && cached.fingerprint === fingerprint) return cached.provider;
    const provider = this.factory({ id: record.id, kind: record.kind, preset: record.preset, apiKey: key, baseUrl: record.baseUrl }, record, this.catalog);
    this.instances.set(providerId, { fingerprint, provider });
    return provider;
  }

  invalidate(providerId: string): void {
    this.versions.set(providerId, (this.versions.get(providerId) ?? 0) + 1);
    this.instances.delete(providerId);
    this.cache.delete(providerId);
    this.previous.delete(providerId);
    this.snapshots?.delete(providerId);
  }

  async listModels(providerId: string, options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<ModelInfo[]> {
    options.signal?.throwIfAborted();
    this.checkCatalog();
    const hit = this.cache.get(providerId);
    if (hit && !options.refresh && Date.now() - hit.at < MODEL_CACHE_MS) return hit.models.map((m) => withModelLifecycle(m));
    const version = this.versions.get(providerId) ?? 0;
    const revision = this.catalogRevision;
    const previous = this.previous.get(providerId) ?? this.snapshots?.get(providerId);
    const listed = await this.get(providerId).listModels(options.signal);
    options.signal?.throwIfAborted();
    const models = this.withCatalogPricing(providerId, listed).map((m): ModelInfo => {
      const record = this.repo.get(providerId);
      const preset = record?.preset ?? (record ? NATIVE_PRESET[record.kind] : null);
      const metadata = this.catalog?.model(preset ?? null, m.ref.modelId);
      return { ...m, ...(metadata ? { catalogCapabilities: metadata.capabilities } : {}),
        availability: metadata?.deprecated ? { state: 'deprecated', source: 'catalog', checkedAt: Date.now(), reason: 'Marked deprecated in Models.dev; it may still be available.', selectable: true }
          : m.availability ?? { state: 'available', source: 'provider', checkedAt: Date.now(), reason: null, selectable: true } };
    });
    const listedIds = new Set(models.map((m) => m.ref.modelId));
    for (const m of previous?.models ?? []) {
      if (listedIds.has(m.ref.modelId)) continue;
      models.push({ ...m, availability: { state: 'unknown', source: 'cache', checkedAt: Date.now(),
        reason: 'Previously listed, but omitted by the latest provider response. Retirement is unconfirmed. Refresh to retry.', selectable: false } });
    }
    // A response begun before a key/endpoint/catalog change must not repopulate the new cache.
    if (version !== (this.versions.get(providerId) ?? 0) || revision !== (this.catalog?.revision ?? 0)) {
      throw new GraftError('provider_changed', 'The provider configuration changed during model discovery. Refresh to retry.');
    }
    const snapshot = { at: Date.now(), models: models.map((m) => withModelLifecycle(m)) };
    this.snapshots?.save(providerId, snapshot);
    this.previous.set(providerId, snapshot);
    this.cache.set(providerId, snapshot);
    return snapshot.models;
  }

  /** Fills in prices the provider's own list doesn't report (Anthropic, Gemini) from the catalog. */
  private withCatalogPricing(providerId: string, models: ModelInfo[]): ModelInfo[] {
    const record = this.repo.get(providerId);
    const preset = record ? (record.preset ?? NATIVE_PRESET[record.kind] ?? null) : null;
    if (!preset || !this.catalog) return models;
    return models.map((m) => {
      if (m.pricing) return m;
      const known = modelPricing(this.catalog?.model(preset, m.ref.modelId)?.pricing ?? null);
      return known ? { ...m, pricing: known } : m;
    });
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
          const previous = this.previous.get(r.id) ?? this.snapshots?.get(r.id);
          const models = (previous?.models ?? []).map((m): ModelInfo => withModelLifecycle({ ...m, availability: {
            state: code === 'auth' || code === 'missing_key' ? 'not-accessible' : ['rate_limit', 'server', 'overloaded', 'network'].includes(code) ? 'temporarily-unavailable' : 'unknown',
            source: 'cache', checkedAt: m.availability?.checkedAt ?? previous?.at ?? null,
            reason: 'Provider discovery failed; retained metadata is not evidence of retirement. Check the connection and refresh.', selectable: false
          } }));
          return { providerId: r.id, models, error: { code, message } };
        }
      })
    );
  }

  async resolveModel(ref: ModelRef, signal?: AbortSignal): Promise<ModelInfo> {
    const models = await this.listModels(ref.providerId, signal ? { signal } : {});
    const found = models.find((m) => m.ref.modelId === ref.modelId);
    if (found?.availability?.selectable === false) throw new GraftError('model_unavailable', found.availability.reason ?? 'Refresh the model list or select a replacement.');
    if (found) return found;
    throw new GraftError('model_not_found', `The provider did not list "${ref.modelId}". This does not confirm retirement. Retry or choose another model; your conversation and selection are preserved.`);
  }

  /** Verifies unsaved credentials with a real list-models call. Never throws. */
  async verifyDraft(
    draft: { kind: ProviderKind; preset: string | null; baseUrl: string | null; apiKey: string | null },
    signal?: AbortSignal
  ): Promise<VerifyResult> {
    try {
      const provider = this.factory(
        { id: 'verify', kind: draft.kind, preset: draft.preset, apiKey: draft.apiKey, baseUrl: normalizeBaseUrl(draft.baseUrl) },
        { customModels: [] },
        this.catalog
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
