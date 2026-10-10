import { describe, expect, it } from 'vitest';
import { spentTokens, TurnBudget } from '../../src/main/agent/turnBudget';

const used = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });
const NONE = { tokens: null, costUsd: null, minutes: null };

/** A clock the test moves by hand. */
function clock(start = 1_000_000): { now: () => number; pass: (ms: number) => void } {
  let at = start;
  return { now: () => at, pass: (ms) => void (at += ms) };
}

describe('the limits of one turn', () => {
  it('counts the tokens that cost money: cache reads at the tenth they are billed at', () => {
    expect(spentTokens(used(1000, 50))).toBe(1050);
    expect(spentTokens(used(100, 20, 10_000, 400))).toBe(100 + 20 + 400 + 1000);
  });

  it('never pauses a turn that has no limits', () => {
    const budget = new TurnBudget(NONE);
    budget.add(used(50_000_000, 1_000_000), 9999, 'Big Model');
    expect(budget.exceeded()).toBeNull();
  });

  it('pauses once the tokens of the turn and of everything it started pass the limit, and says how many', () => {
    const budget = new TurnBudget({ ...NONE, tokens: 2000 });
    budget.add(used(1000, 50), null, 'Main Model');
    expect(budget.exceeded()).toBeNull();
    // A sub-agent's request counts toward the same turn.
    budget.add(used(900, 51), null, 'Small Model');
    expect(budget.exceeded()).toBe('Paused after about 2,001 tokens, past the limit of 2,000 for one turn set in Settings → Permissions.');
  });

  it('pauses on cost, calls it an estimate, and says what is not in it', () => {
    const budget = new TurnBudget({ ...NONE, costUsd: 0.5 });
    expect(budget.add(used(1000, 50), 0.3, 'Priced Model')).toBeNull();
    expect(budget.exceeded()).toBeNull();
    budget.spend(0.15);
    expect(budget.exceeded()).toBeNull();
    budget.add(used(1000, 50), 0.06, 'Priced Model');
    expect(budget.exceeded()).toBe('Paused at about $0.51, past the limit of $0.50 for one turn set in Settings → Permissions. The amount comes from published prices and can differ from your bill.');
  });

  it('says once that a model with no published price is outside the cost limit, and counts it in the pause', () => {
    const budget = new TurnBudget({ ...NONE, costUsd: 0.5 });
    expect(budget.add(used(1000, 50), null, 'Local Model')).toBe("The cost limit for one turn can't follow Local Model: it has no published price. Its requests are counted in tokens and time only.");
    // Said once a turn, not with every request.
    expect(budget.add(used(1000, 50), null, 'Local Model')).toBeNull();
    expect(budget.exceeded()).toBeNull();
    budget.add(used(10, 10), 0.75, 'Priced Model');
    expect(budget.exceeded()).toBe(
      'Paused at about $0.75, past the limit of $0.50 for one turn set in Settings → Permissions. The amount comes from published prices and can differ from your bill; 2 requests had no published price and are not in it.'
    );
  });

  it('says nothing about prices when no cost limit is set', () => {
    const budget = new TurnBudget({ ...NONE, tokens: 1_000_000 });
    expect(budget.add(used(1000, 50), null, 'Local Model')).toBeNull();
  });

  it('pauses after the minutes it worked, and the time it waited for an answer is not work', () => {
    const time = clock();
    const budget = new TurnBudget({ ...NONE, minutes: 10 }, time.now);
    time.pass(9 * 60_000);
    expect(budget.exceeded()).toBeNull();
    // Half an hour at a permission prompt: the user's time, not the turn's.
    budget.waiting(true);
    time.pass(30 * 60_000);
    expect(budget.exceeded()).toBeNull();
    budget.waiting(false);
    time.pass(59_000);
    expect(budget.exceeded()).toBeNull();
    time.pass(2_000);
    expect(budget.exceeded()).toBe('Paused after 10 minutes of work, the limit for one turn set in Settings → Permissions.');
  });

  it('keeps the clock right when asked twice, and when the answer comes without a question', () => {
    const time = clock();
    const budget = new TurnBudget({ ...NONE, minutes: 1 }, time.now);
    budget.waiting(false);
    budget.waiting(true);
    time.pass(40_000);
    budget.waiting(true);
    time.pass(40_000);
    budget.waiting(false);
    budget.waiting(false);
    time.pass(59_000);
    expect(budget.exceeded()).toBeNull();
    time.pass(1_000);
    expect(budget.exceeded()).toBe('Paused after 1 minute of work, the limit for one turn set in Settings → Permissions.');
  });

  it('names the first limit that was passed: tokens, then cost, then time', () => {
    const time = clock();
    const budget = new TurnBudget({ tokens: 100, costUsd: 0.01, minutes: 1 }, time.now);
    budget.add(used(1000, 0), 1, 'Priced Model');
    time.pass(5 * 60_000);
    expect(budget.exceeded()).toMatch(/^Paused after about 1,000 tokens/);
  });
});
