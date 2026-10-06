import type { ModelRoleId } from '@shared/schemas/agentRuns';
import type { ModelRef } from '@shared/schemas/common';
import type { ModelInfo } from '@shared/schemas/models';
import { formatTokenCount } from '../../lib/format';

/** The value of the choice that names no model: routing decides. */
const NO_MODEL = '';

/** A model as the value of a select option. A newline can't appear in either id. */
export function modelKey(ref: ModelRef): string {
  return `${ref.providerId}\n${ref.modelId}`;
}

export function modelOfKey(key: string, models: ModelInfo[]): ModelRef | null {
  return key === NO_MODEL ? null : (models.find((m) => modelKey(m.ref) === key)?.ref ?? null);
}

/**
 * The models a kind of agent work can be given: those that use tools (an agent
 * without tools can do nothing), and for work that looks at screens only those
 * that see images. First comes the choice to name none.
 */
export function roleModelOptions(
  role: ModelRoleId,
  models: ModelInfo[],
  current: ModelRef | null,
  routing: 'session' | 'auto',
  providerLabels: Record<string, string>
): Array<{ value: string; label: string }> {
  const usable = models.filter((m) => m.supportsTools && (role !== 'vision' || m.supportsVision));
  // Named by provider whenever there is more than one, in every list alike.
  const several = new Set(models.map((m) => m.ref.providerId)).size > 1;
  const options = [
    { value: NO_MODEL, label: routing === 'auto' ? 'Automatic' : 'The session’s model' },
    ...usable.map((m) => ({ value: modelKey(m.ref), label: several ? `${m.label} · ${providerLabels[m.ref.providerId] ?? m.ref.providerId}` : m.label }))
  ];
  // A model that was chosen and has since gone stays visible: agents fall back to the session's model until another is picked.
  if (current && !options.some((o) => o.value === modelKey(current))) options.push({ value: modelKey(current), label: `${current.modelId} (no longer available)` });
  return options;
}

/** Tokens one agent may spend before it is stopped. */
export const BUDGET_CHOICES: Array<number | null> = [null, 100_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000];

export function budgetLabel(tokens: number | null): string {
  return tokens === null ? 'No limit' : `${formatTokenCount(tokens)} tokens`;
}
