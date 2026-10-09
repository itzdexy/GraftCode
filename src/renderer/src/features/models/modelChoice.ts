import { EFFORT_LEVELS, type EffortLevel, type ModelRef } from '@shared/schemas/common';
import type { ModelInfo } from '@shared/schemas/models';

/** Pure helpers for model and effort pickers (no store access, for testing). */

export interface ProviderModels {
  providerId: string;
  models: ModelInfo[];
}

export function sameModel(a: ModelRef | null | undefined, b: ModelRef | null | undefined): boolean {
  return !!a && !!b && a.providerId === b.providerId && a.modelId === b.modelId;
}

/** The model a ref points at, or the first featured model when the ref is missing or stale. */
export function resolveModel(groups: ProviderModels[], ref: ModelRef | null): ModelInfo | null {
  const all = groups.flatMap((g) => g.models);
  if (ref) {
    const found = all.find((m) => sameModel(m.ref, ref));
    if (found) return found;
  }
  return all.find((m) => m.featured) ?? all[0] ?? null;
}

/** Up to nine featured models (number keys 1–9); the current model is always included. */
export function quickModels(groups: ProviderModels[], current: ModelInfo | null, limit = 9): ModelInfo[] {
  const featured = groups.flatMap((g) => g.models.filter((m) => m.featured && m.availability?.selectable !== false));
  const list = featured.slice(0, limit);
  if (current && !list.some((m) => sameModel(m.ref, current.ref))) {
    if (list.length >= limit) list.pop();
    list.push(current);
  }
  return list;
}

/** Models not in the quick list, grouped by provider, for "More models". */
export function moreModels(groups: ProviderModels[], quick: ModelInfo[]): ProviderModels[] {
  return groups
    .map((g) => ({ providerId: g.providerId, models: g.models.filter((m) => !quick.some((q) => sameModel(q.ref, m.ref))) }))
    .filter((g) => g.models.length > 0);
}

/**
 * Effort to use with a model: null when the model has no effort control;
 * otherwise the requested level if supported, else the closest supported
 * level below it, else the model's default.
 */
export function effortFor(model: ModelInfo | null, requested: EffortLevel | null): EffortLevel | null {
  const support = model?.effort;
  if (!support) return null;
  if (requested && support.levels.includes(requested)) return requested;
  if (requested) {
    // Step down to the nearest supported level, but never to "Off": that only happens when chosen.
    const index = EFFORT_LEVELS.indexOf(requested);
    for (let i = index - 1; i >= 0; i--) {
      const level = EFFORT_LEVELS[i];
      if (level && level !== 'none' && support.levels.includes(level)) return level;
    }
  }
  return support.default;
}

export function allModelsOf(groups: ProviderModels[]): ModelInfo[] {
  return groups.flatMap((g) => g.models);
}
