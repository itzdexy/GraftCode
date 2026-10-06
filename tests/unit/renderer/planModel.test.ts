import { describe, expect, it } from 'vitest';
import { PLAN_MAX, planBarText, planEdit } from '../../../src/renderer/src/features/session/planModel';

describe('a plan in the interface', () => {
  it('sends an edit only when it changed something, and never an empty plan', () => {
    expect(planEdit('1. A', '1. A\n2. B')).toEqual({ canApprove: true, plan: '1. A\n2. B' });
    expect(planEdit('1. A', '  1. A \n')).toEqual({ canApprove: true, plan: undefined });
    expect(planEdit('1. A', '   ')).toEqual({ canApprove: false, plan: undefined });
    expect(planEdit('1. A', '')).toEqual({ canApprove: false, plan: undefined });
    // Never more than the IPC accepts: the box stops there too.
    expect(PLAN_MAX).toBe(50_000);
  });

  it('names the plan and says how far the tasks are', () => {
    const plan = { plan: '## Add rate limiting\n\n1. Read the router', messageId: 'm', at: 1 };
    expect(planBarText(plan, [])).toEqual({ title: 'Plan: Add rate limiting', progress: null });
    expect(
      planBarText(plan, [
        { id: '1', content: 'a', status: 'completed' },
        { id: '2', content: 'b', status: 'pending' }
      ])
    ).toEqual({ title: 'Plan: Add rate limiting', progress: '1 of 2 done' });
  });
});
