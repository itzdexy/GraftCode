import fs from 'node:fs';
import type { EffortLevel, ProviderKind } from '@shared/schemas/common';
import type { EffortSupport, ModelInfo, ProviderPreset } from '@shared/schemas/models';
import { isLocalUrl } from '@shared/privacy';
import { effortSupport } from './catalog';

/**
 * Provider presets and model metadata from resources/catalog/models.json
 * (generated from models.dev by scripts/update-catalog.mjs). Read lazily on
 * first use; a missing or unreadable file leaves the catalog empty so live
 * list-models data still works.
 */

/** Compact model record as written by the generator (see compactModel there). */
interface RawModel {
  id: string;
  n: string;
  f?: string;
  t?: 1;
  v?: 1;
  r?: 1;
  e?: string[];
  b?: [number, number];
  g?: 1;
  i?: string;
  c?: number;
  o?: number;
  /** [input, output, cache read, cache write] in USD per million tokens. */
  p?: Array<number | null>;
  d?: string;
  s?: string;
}

interface RawProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  api: string | null;
  env: string[];
  doc: string | null;
  key: 'required' | 'optional';
  models: RawModel[];
}

export interface CatalogModel {
  id: string;
  name: string;
  family: string | null;
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  /** Provider-native effort values, e.g. ["minimal","low","medium","high"]. */
  effortValues: string[] | null;
  /** Thinking-token budget range when the model takes a budget instead of levels. */
  budget: { min: number; max: number } | null;
  /** Reasoning can be switched off. */
  toggle: boolean;
  /** Field that carries reasoning between tool calls ("reasoning_content" / "reasoning_details"). */
  interleaved: string | null;
  context: number | null;
  output: number | null;
  /** USD per million tokens. */
  pricing: { input: number; output: number; cacheRead: number | null; cacheWrite: number | null } | null;
  releasedAt: number | null;
  deprecated: boolean;
}

/** Ollama runs locally and has its own adapter; it isn't in the generated catalog. */
const OLLAMA: ProviderPreset = {
  id: 'ollama',
  name: 'Ollama',
  kind: 'ollama',
  baseUrl: 'http://localhost:11434',
  key: 'none',
  docUrl: 'https://ollama.com',
  envVars: [],
  modelCount: 0,
  local: true
};


function toModel(raw: RawModel): CatalogModel {
  const released = raw.d ? Date.parse(raw.d) : Number.NaN;
  return {
    id: raw.id,
    name: raw.n,
    family: raw.f ?? null,
    tools: raw.t === 1,
    vision: raw.v === 1,
    reasoning: raw.r === 1,
    effortValues: raw.e && raw.e.length > 0 ? raw.e : null,
    budget: raw.b ? { min: raw.b[0], max: raw.b[1] } : null,
    toggle: raw.g === 1,
    interleaved: raw.i ?? null,
    context: raw.c ?? null,
    output: raw.o ?? null,
    pricing:
      raw.p && raw.p.length >= 2 && typeof raw.p[0] === 'number' && typeof raw.p[1] === 'number'
        ? { input: raw.p[0], output: raw.p[1], cacheRead: raw.p[2] ?? null, cacheWrite: raw.p[3] ?? null }
        : null,
    releasedAt: Number.isFinite(released) ? released : null,
    deprecated: raw.s === 'deprecated'
  };
}

/** Catalog prices in the shape models carry (cache prices only when the catalog has them). */
export function modelPricing(pricing: CatalogModel['pricing']): ModelInfo['pricing'] {
  if (!pricing) return null;
  return {
    input: pricing.input,
    output: pricing.output,
    ...(pricing.cacheRead !== null ? { cacheRead: pricing.cacheRead } : {}),
    ...(pricing.cacheWrite !== null ? { cacheWrite: pricing.cacheWrite } : {})
  };
}

export class ProviderCatalog {
  private data: { providers: RawProvider[]; byId: Map<string, RawProvider>; models: Map<string, Map<string, RawModel>> } | null = null;

  constructor(
    private readonly file: string | null,
    private readonly log: (message: string) => void = () => undefined
  ) {}

  private load(): NonNullable<ProviderCatalog['data']> {
    if (this.data) return this.data;
    let providers: RawProvider[] = [];
    if (this.file) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { providers?: RawProvider[] };
        providers = Array.isArray(parsed.providers) ? parsed.providers : [];
      } catch (error) {
        this.log(`Provider catalog unavailable (${this.file}): ${(error as Error).message}`);
      }
    }
    const byId = new Map(providers.map((p) => [p.id, p]));
    const models = new Map(providers.map((p) => [p.id, new Map(p.models.map((m) => [m.id, m]))]));
    this.data = { providers, byId, models };
    return this.data;
  }

  /** Every preset, including built-in Ollama, sorted by name. */
  presets(): ProviderPreset[] {
    const list = this.load().providers.map(
      (p): ProviderPreset => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        baseUrl: p.api,
        key: p.key,
        docUrl: p.doc,
        envVars: p.env,
        modelCount: p.models.length,
        local: p.api !== null && isLocalUrl(p.api)
      })
    );
    return [...list, OLLAMA].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  }

  preset(id: string): ProviderPreset | null {
    return this.presets().find((p) => p.id === id) ?? null;
  }

  model(presetId: string | null, modelId: string): CatalogModel | null {
    if (!presetId) return null;
    const raw = this.load().models.get(presetId)?.get(modelId);
    return raw ? toModel(raw) : null;
  }

  /** The catalog's model list for a preset (used when a provider has no list-models endpoint). */
  models(presetId: string): CatalogModel[] {
    return (this.load().byId.get(presetId)?.models ?? []).map(toModel);
  }
}

/** Preset id used for catalog lookups by each native adapter. */
export const NATIVE_PRESET: Partial<Record<ProviderKind, string>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'google',
  openrouter: 'openrouter'
};

const NATIVE_LEVEL: Record<string, EffortLevel> = {
  none: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'extra',
  max: 'max'
};

/** Highest native value first, for picking what Taproot runs at. */
const STRENGTH = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'];

/**
 * Effort control for a model from its catalog entry. `values` maps each UI
 * level to the provider's wire value (a named level, or a token budget).
 * `fallback` applies to reasoning models the catalog has no options for;
 * `allowOff` adds "Off" when the model's reasoning can be switched off.
 */
export function catalogEffort(
  meta: CatalogModel | null,
  options: { reasoning: boolean; fallback: string[]; allowOff: boolean; budgets: boolean }
): EffortSupport | null {
  const values: Partial<Record<EffortLevel, string | number>> = {};
  const named = meta?.effortValues ?? null;
  if (named) {
    for (const v of named) {
      const level = NATIVE_LEVEL[v];
      if (level && (level !== 'none' || options.allowOff)) values[level] = v;
    }
  } else if (meta?.budget && options.budgets) {
    const { min, max } = meta.budget;
    const clamp = (n: number): number => Math.max(Math.max(min, 1024), Math.min(max, n));
    values.low = clamp(2048);
    values.medium = clamp(8192);
    values.high = clamp(16_000);
    values.extra = clamp(24_000);
    values.max = clamp(max);
  } else if (options.reasoning || meta?.reasoning || meta?.toggle) {
    for (const v of options.fallback) {
      const level = NATIVE_LEVEL[v];
      if (level) values[level] = v;
    }
  }
  if (Object.keys(values).length === 0) return null;
  if (meta?.toggle && options.allowOff && values.none === undefined) values.none = 'none';
  const strongest = named ? STRENGTH.find((v) => named.includes(v) && v !== 'none') : undefined;
  values.taproot = strongest ?? values.max ?? values.extra ?? values.high ?? values.medium ?? 'high';
  const support = effortSupport(Object.keys(values) as EffortLevel[]);
  return support ? { ...support, values } : null;
}
