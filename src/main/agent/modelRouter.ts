import type { ModelRef } from '@shared/schemas/common';
import { MODEL_ROLE_LABELS, type ModelRoleId } from '@shared/schemas/agentRuns';
import type { ModelInfo } from '@shared/schemas/models';

/**
 * Picks the model an agent runs on, and says why. Order: the model assigned
 * to the agent's role in Settings; then, with automatic routing, the cheapest
 * capable model for quick and research work; otherwise the session's model.
 * It only ever chooses among models the user has, and automatic routing stays
 * on the session's provider, so a different key is never spent unasked.
 */
export interface RouteInput {
  modelRole: ModelRoleId;
  needsVision: boolean;
  /** The model the session runs on. */
  session: ModelInfo;
  /** Every model the user can use right now. */
  candidates: ModelInfo[];
  routing: 'session' | 'auto';
  assignments: Partial<Record<ModelRoleId, ModelRef | null>>;
}

export interface Route {
  ref: ModelRef;
  model: ModelInfo;
  /** Plain sentences, shown in the agent graph. */
  reasons: string[];
}

/** Roles whose work is mostly reading: a small model does it well for a fraction of the price. */
const LIGHT_ROLES: ReadonlySet<ModelRoleId> = new Set(['fast', 'research']);
const MIN_CONTEXT = 32_000;

function same(a: ModelRef, b: ModelRef): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

/** Agents read far more than they write, so input price weighs three times the output price. */
function score(model: ModelInfo): number | null {
  return model.pricing ? model.pricing.input * 3 + model.pricing.output : null;
}

function capable(model: ModelInfo, needsVision: boolean): boolean {
  return model.availability?.selectable !== false && model.supportsTools && (!needsVision || model.supportsVision);
}

export function routeModel(input: RouteInput): Route {
  const reasons: string[] = [];
  const label = MODEL_ROLE_LABELS[input.modelRole];
  const assigned = input.assignments[input.modelRole];
  if (assigned) {
    const found = input.candidates.find((m) => same(m.ref, assigned));
    if (found && capable(found, input.needsVision)) {
      return { ref: found.ref, model: found, reasons: [`Assigned to the ${label} role in Settings → Models.`] };
    }
    reasons.push(
      found
        ? `The model assigned to the ${label} role (${found.label}) can't ${found.supportsTools ? 'see images, which this agent needs' : 'use tools'}, so it wasn't used.`
        : `The model assigned to the ${label} role (${assigned.modelId}) isn't available anymore, so it wasn't used.`
    );
  }
  if (input.routing === 'auto' && LIGHT_ROLES.has(input.modelRole)) {
    const sessionScore = score(input.session);
    const pool = input.candidates
      .filter((m) => m.ref.providerId === input.session.ref.providerId && capable(m, input.needsVision) && m.contextWindow >= MIN_CONTEXT)
      .map((m) => ({ model: m, score: score(m) }))
      .filter((entry): entry is { model: ModelInfo; score: number } => entry.score !== null)
      .sort((a, b) => a.score - b.score);
    const best = pool[0];
    if (best && sessionScore !== null && best.score < sessionScore && best.model.pricing) {
      const { input: inPrice, output: outPrice } = best.model.pricing;
      return {
        ref: best.model.ref,
        model: best.model,
        reasons: [
          ...reasons,
          `Cheapest model from this provider that can use tools${input.needsVision ? ' and see images' : ''}: $${String(inPrice)} in and $${String(outPrice)} out per million tokens.`,
          `${label} work is mostly reading, so it doesn't need the session's model (${input.session.label}).`
        ]
      };
    }
  }
  const why =
    input.routing === 'auto' && !LIGHT_ROLES.has(input.modelRole)
      ? `The session's model: ${label.toLowerCase()} work gets its strongest reasoning.`
      : assigned
        ? "The session's model."
        : `The session's model (no model is assigned to the ${label} role).`;
  return { ref: input.session.ref, model: input.session, reasons: [...reasons, why] };
}
