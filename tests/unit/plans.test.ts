import { describe, expect, it } from 'vitest';
import type { ContentBlock, MessageMeta, StoredMessage } from '../../src/shared/schemas/messages';
import { currentPlan, planProgress, planTitle } from '../../src/shared/plans';

let seq = 0;
const message = (content: ContentBlock[], meta: MessageMeta = {}): StoredMessage => ({ id: `m${String(++seq)}`, sessionId: 's', seq, role: 'user', content, meta, createdAt: seq * 1000 });
const decided = (plan: string, approved: boolean): StoredMessage =>
  message([{ type: 'tool_result', toolUseId: 'p', isError: false, content: [], display: { kind: 'plan', plan, approved, feedback: null } }]);

describe('the current plan', () => {
  it('is the newest plan the user approved', () => {
    const first = decided('1. A', true);
    expect(currentPlan([message([{ type: 'text', text: 'hi' }]), first])).toEqual({ plan: '1. A', messageId: first.id, at: first.createdAt });
    expect(currentPlan([first, decided('1. B', false)])?.plan).toBe('1. A');
    expect(currentPlan([first, decided('1. C', true)])?.plan).toBe('1. C');
    expect(currentPlan([decided('1. D', false)])).toBeNull();
    expect(currentPlan([])).toBeNull();
  });

  it('ends at /clear, and a plan approved after it counts again', () => {
    const before = decided('1. A', true);
    const cleared = message([{ type: 'text', text: 'Context cleared.' }], { kind: 'command-output', cleared: true });
    expect(currentPlan([before, cleared])).toBeNull();
    expect(currentPlan([before, cleared, decided('1. E', true)])?.plan).toBe('1. E');
  });

  it('is found whatever order the messages arrive in', () => {
    const first = decided('1. A', true);
    const second = decided('1. B', true);
    expect(currentPlan([second, first])?.plan).toBe('1. B');
  });

  it('is named by its first heading or line, and counts the tasks done', () => {
    expect(planTitle('## Add rate limiting\n\n1. Read the router')).toBe('Add rate limiting');
    expect(planTitle('\n**Goal:** ship `v2`\nmore')).toBe('Goal: ship v2');
    expect(planTitle('1. Read the router\n2. Add it')).toBe('Read the router');
    expect(planTitle('- [ ] Read the router')).toBe('Read the router');
    expect(planTitle('   ')).toBe('Plan');
    const long = planTitle(`${'word '.repeat(30)}end`);
    expect(long).toHaveLength(60);
    expect(long.endsWith('…')).toBe(true);
    expect(planProgress([])).toBeNull();
    expect(
      planProgress([
        { id: '1', content: 'a', status: 'completed' },
        { id: '2', content: 'b', status: 'in_progress' },
        { id: '3', content: 'c', status: 'pending' }
      ])
    ).toEqual({ done: 1, total: 3 });
  });
});
