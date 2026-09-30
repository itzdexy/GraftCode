import { RECOMMENDED_EFFORT, type EffortLevel } from '@shared/schemas/common';
import type { EffortSupport, ModelInfo } from '@shared/schemas/models';

/**
 * Provider-neutral helpers that turn raw list-models data into ModelInfo.
 * Nothing here names a specific model; grouping and ordering come from the
 * ids and metadata the provider returns.
 */

/** Words that mark a provider's small/fast tier; used to pick a model for background work. */
const FAST_TIER = /(^|[-_.:/ ])(mini|nano|lite|small|flash|haiku|fast|instant|tiny)(?=$|[-_.:/ ])/i;
const NOISE_TOKENS = new Set(['latest', 'preview', 'exp', 'experimental', 'beta', 'alpha', 'free']);
const VERSION_TOKEN = /^(v?\d+(\.\d+)*[a-z]?|\d{6,8})$/i;

export function isFastTier(id: string): boolean {
  return FAST_TIER.test(id);
}

/** Model line without versions/dates: "vendor-line-9-2-20250101" → "vendor-line". */
export function familyOf(id: string): string {
  const base = id.toLowerCase().split('/').pop() ?? id.toLowerCase();
  const tokens = base
    .split(/[-_:]/)
    .filter((t) => t.length > 0 && !VERSION_TOKEN.test(t) && !NOISE_TOKENS.has(t) && !/^\d{4}$/.test(t));
  return tokens.join('-') || base;
}

/** Numeric tokens in order, for comparing versions when no creation date exists. */
export function versionKey(id: string): number[] {
  return (id.match(/\d+(\.\d+)?/g) ?? []).flatMap((part) => part.split('.').map(Number));
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

function newerFirst(a: ModelInfo, b: ModelInfo): number {
  if (a.createdAt !== null && b.createdAt !== null && a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return compareVersions(versionKey(b.ref.modelId), versionKey(a.ref.modelId));
}

/**
 * Marks the newest model of each family as featured (at most `limit`
 * families, most recent first) and orders the list: featured first, then the
 * rest newest-first.
 */
export function arrangeModels(models: ModelInfo[], limit = 6): ModelInfo[] {
  const sorted = [...models].sort(newerFirst);
  const heads = new Map<string, ModelInfo>();
  for (const m of sorted) if (!heads.has(m.family)) heads.set(m.family, m);
  const featuredIds = new Set([...heads.values()].slice(0, limit).map((m) => m.ref.modelId));
  const arranged = sorted.map((m) => ({ ...m, featured: featuredIds.has(m.ref.modelId) }));
  return [...arranged.filter((m) => m.featured), ...arranged.filter((m) => !m.featured)];
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1))}M`;
  if (n >= 1000) return `${Math.round(n / 1024) * 1024 === n ? n / 1024 : Math.round(n / 1000)}K`;
  return String(n);
}

/** One-line capability summary used as the model's menu description. */
export function describeCapabilities(info: {
  contextWindow: number;
  supportsVision: boolean;
  effort: EffortSupport | null;
  supportsTools: boolean;
}): string {
  const parts = [`${formatTokens(info.contextWindow)} context`];
  if (info.effort) parts.push(info.effort.levels.includes('max') ? 'deep reasoning' : 'reasoning');
  if (info.supportsVision) parts.push('vision');
  if (!info.supportsTools) parts.push('no tools');
  return parts.join(' · ');
}

/** "vendor-model-5.1-mini" → "Vendor Model 5.1 Mini" for providers without display names. */
export function labelFromId(id: string): string {
  const base = id.split('/').pop() ?? id;
  return base
    .split(/[-_]/)
    .filter(Boolean)
    .map((token) => {
      if (/^gpt$/i.test(token)) return 'GPT';
      if (/^[a-z]\d/i.test(token)) return token.toLowerCase();
      return /^[a-z]/i.test(token) ? token[0]!.toUpperCase() + token.slice(1) : token;
    })
    .join(' ')
    .replace(/^GPT (\d)/, 'GPT-$1');
}

/** Builds effort support for a level set; null when the set is empty. */
export function effortSupport(levels: EffortLevel[]): EffortSupport | null {
  if (levels.length === 0) return null;
  const order: EffortLevel[] = ['low', 'medium', 'high', 'extra', 'max', 'taproot'];
  const sorted = order.filter((l) => levels.includes(l));
  const recommended = sorted.includes(RECOMMENDED_EFFORT)
    ? RECOMMENDED_EFFORT
    : (sorted.find((l) => l !== 'low' && l !== 'taproot') ?? sorted[0]!);
  return { levels: sorted, recommended, default: recommended };
}

/** Thinking-token budgets for providers that take a budget instead of named levels. */
export const THINKING_BUDGETS: Record<EffortLevel, number> = {
  low: 0,
  medium: 4096,
  high: 10_000,
  extra: 16_000,
  max: 24_000,
  taproot: 32_000
};

/** Picks the closest available value at or below the requested level, else the lowest above it. */
export function nearestAvailable<T>(level: EffortLevel, available: Partial<Record<EffortLevel, T>>): T | undefined {
  const order: EffortLevel[] = ['low', 'medium', 'high', 'extra', 'max', 'taproot'];
  const index = order.indexOf(level);
  for (let i = index; i >= 0; i--) {
    const v = available[order[i]!];
    if (v !== undefined) return v;
  }
  for (let i = index + 1; i < order.length; i++) {
    const v = available[order[i]!];
    if (v !== undefined) return v;
  }
  return undefined;
}
