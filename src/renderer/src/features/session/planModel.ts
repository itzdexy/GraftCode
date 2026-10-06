import { planProgress, planTitle, type ApprovedPlan } from '@shared/plans';
import type { TodoItem } from '@shared/schemas/toolDisplay';

/** The most a plan may hold once edited; the box stops here and so does the request that carries it. */
export const PLAN_MAX = 50_000;

/**
 * What an edit of a plan amounts to. `plan` is what goes with the approval:
 * the user's version when it says something else than the plan offered, and
 * nothing when only the spacing changed. A plan edited down to nothing can't
 * be approved.
 */
export function planEdit(original: string, draft: string): { canApprove: boolean; plan: string | undefined } {
  const edited = draft.trim();
  if (edited.length === 0) return { canApprove: false, plan: undefined };
  return { canApprove: true, plan: edited === original.trim() ? undefined : edited };
}

/** The two texts of the plan bar: what the plan is called, and how far the session's tasks are. */
export function planBarText(plan: ApprovedPlan, todos: TodoItem[]): { title: string; progress: string | null } {
  const progress = planProgress(todos);
  return { title: `Plan: ${planTitle(plan.plan)}`, progress: progress ? `${String(progress.done)} of ${String(progress.total)} done` : null };
}

/**
 * A plan's card in the transcript: the plan as the agent offered it while it
 * waits or after it was sent back, and the version the user approved once
 * there is one. That version is what the agent follows, so it is what the
 * card must show.
 */
export function planShown(
  offered: string,
  display: { plan: string; approved: boolean } | null
): { text: string; status: string; tone: 'neutral' | 'warning' | 'accent' } {
  if (!display) return { text: offered, status: 'Waiting for approval', tone: 'neutral' };
  if (!display.approved) return { text: offered, status: 'Changes requested', tone: 'warning' };
  const edited = display.plan.trim() !== offered.trim();
  return { text: edited ? display.plan : offered, status: edited ? 'Approved with your changes' : 'Approved', tone: 'accent' };
}
