import { describe, expect, it } from 'vitest';
import { PLAN_MAX, planBarText, planEdit, planShown } from '../../../src/renderer/src/features/session/planModel';

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

  it('shows the plan that was agreed on in the transcript, and says when the user changed it', () => {
    // Waiting, or sent back: the plan as the agent offered it.
    expect(planShown('1. A', null)).toEqual({ text: '1. A', status: 'Waiting for approval', tone: 'neutral' });
    expect(planShown('1. A', { plan: '1. A', approved: false })).toEqual({ text: '1. A', status: 'Changes requested', tone: 'warning' });
    expect(planShown('1. A', { plan: '1. A', approved: true })).toEqual({ text: '1. A', status: 'Approved', tone: 'accent' });
    expect(planShown('1. A', { plan: ' 1. A\n', approved: true })).toMatchObject({ status: 'Approved' });
    // Approved after an edit: the user's version, which is the one the agent follows.
    expect(planShown('1. A', { plan: '1. A\n2. B', approved: true })).toEqual({ text: '1. A\n2. B', status: 'Approved with your changes', tone: 'accent' });
  });
});
