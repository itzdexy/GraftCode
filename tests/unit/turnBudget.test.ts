import { describe, expect, it } from 'vitest';
import { spentTokens, SpendBudget, TurnBudget } from '../../src/main/agent/turnBudget';

const used = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });
const NONE = { tokens: null, costUsd: null, minutes: null, toolCalls: null, retries: null };

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

  it('pauses once the turn and its agents have made their tool calls, and says by how many it went over', () => {
    const budget = new TurnBudget({ ...NONE, toolCalls: 3 });
    budget.toolCall();
    budget.toolCall();
    expect(budget.exceeded()).toBeNull();
    budget.toolCall();
    expect(budget.exceeded()).toBe('Paused after 3 tool calls, the limit for one turn set in Settings → Permissions.');
    // A reply can ask for several at once; they all ran before the turn could be paused.
    budget.toolCall();
    budget.toolCall();
    expect(budget.exceeded()).toBe('Paused after 5 tool calls, past the limit of 3 for one turn set in Settings → Permissions.');
  });

  it('lets a failed request be tried again as often as the limit says, and no more', () => {
    const budget = new TurnBudget({ ...NONE, retries: 2 });
    budget.retry();
    budget.retry();
    expect(budget.exceeded()).toBeNull();
    // The third is the one that is refused.
    budget.retry();
    expect(budget.exceeded()).toBe('Paused after 2 retries of failed requests, the limit for one turn set in Settings → Permissions.');
    const one = new TurnBudget({ ...NONE, retries: 1 });
    one.retry();
    one.retry();
    expect(one.exceeded()).toBe('Paused after 1 retry of a failed request, the limit for one turn set in Settings → Permissions.');
  });

  it('counts nothing against a limit that is not set', () => {
    const budget = new TurnBudget(NONE);
    for (let i = 0; i < 1000; i++) {
      budget.toolCall();
      budget.retry();
    }
    expect(budget.exceeded()).toBeNull();
  });

  it('names the first limit that was passed: tokens, then cost, then time', () => {
    const time = clock();
    const budget = new TurnBudget({ ...NONE, tokens: 100, costUsd: 0.01, minutes: 1 }, time.now);
    budget.add(used(1000, 0), 1, 'Priced Model');
    time.pass(5 * 60_000);
    expect(budget.exceeded()).toMatch(/^Paused after about 1,000 tokens/);
  });
});

const NO_SPEND_LIMITS = { sessionTokens: null, sessionCostUsd: null, projectTokens: null, projectCostUsd: null, dayTokens: null, dayCostUsd: null };
const START = { session: { tokens: 0, costUsd: 0 }, project: { tokens: 0, costUsd: 0 }, day: { tokens: 0, costUsd: 0, unpriced: 0 } };

describe('the limits for a session, a project and a day', () => {
  it('never pauses when no limit is set', () => {
    const budget = new SpendBudget(NO_SPEND_LIMITS, START);
    budget.add(used(50_000_000, 1_000_000), 9999, 'Big Model');
    budget.spend(9999);
    expect(budget.exceeded()).toBeNull();
  });

  it('counts what the session had used before the turn, and pauses past the limit for one session', () => {
    const budget = new SpendBudget({ ...NO_SPEND_LIMITS, sessionTokens: 2000 }, { ...START, session: { tokens: 1200, costUsd: 0 } });
    budget.add(used(700, 50), null, 'Main Model');
    expect(budget.exceeded()).toBeNull();
    // A sub-agent's request counts toward the same session total.
    budget.add(used(30, 30), null, 'Small Model');
    expect(budget.exceeded()).toBe('Paused after about 2,010 tokens in this session, past the limit of 2,000 for one session set in Settings → Permissions.');
  });

  it("counts what the project's sessions had used before the turn, and pauses past the limit for one project", () => {
    const budget = new SpendBudget({ ...NO_SPEND_LIMITS, projectTokens: 2000 }, { ...START, project: { tokens: 1200, costUsd: 0 } });
    budget.add(used(700, 50), null, 'Main Model');
    expect(budget.exceeded()).toBeNull();
    budget.add(used(60, 50), null, 'Small Model');
    expect(budget.exceeded()).toBe('Paused after about 2,060 tokens in this project, past the limit of 2,000 for one project set in Settings → Permissions.');
  });

  it("pauses past the day's token limit, counting the day as it was when the turn started", () => {
    const budget = new SpendBudget({ ...NO_SPEND_LIMITS, dayTokens: 5000 }, { ...START, day: { tokens: 4000, costUsd: 0, unpriced: 0 } });
    budget.add(used(1000, 50), null, 'Main Model');
    expect(budget.exceeded()).toBe('Paused after about 5,050 tokens today, past the limit of 5,000 for one day set in Settings → Permissions.');
  });

  it('pauses at what a session has cost, and counts what a tool paid for', () => {
    const budget = new SpendBudget({ ...NO_SPEND_LIMITS, sessionCostUsd: 1 }, START);
    expect(budget.add(used(100, 10), 0.6, 'Priced Model')).toBeNull();
    expect(budget.exceeded()).toBeNull();
    // A generated picture goes on the user's key and counts too.
    budget.spend(0.25);
    expect(budget.exceeded()).toBeNull();
    budget.add(used(100, 10), 0.2, 'Priced Model');
    expect(budget.exceeded()).toBe(
      'Paused at about $1.05 for this session, past the limit of $1.00 for one session set in Settings → Permissions. The amount comes from published prices and can differ from your bill.'
    );
  });

  it('pauses at what a project has cost, counting what a tool paid for', () => {
    const budget = new SpendBudget({ ...NO_SPEND_LIMITS, projectCostUsd: 2 }, { ...START, project: { tokens: 0, costUsd: 1.5 } });
    budget.add(used(100, 10), 0.4, 'Priced Model');
    expect(budget.exceeded()).toBeNull();
    budget.spend(0.2);
    expect(budget.exceeded()).toBe(
      'Paused at about $2.10 for this project, past the limit of $2.00 for one project set in Settings → Permissions. The amount comes from published prices and can differ from your bill.'
    );
  });

  it('pauses at what the day has cost, and says what requests had no published price', () => {
    const budget = new SpendBudget({ ...NO_SPEND_LIMITS, dayCostUsd: 0.5 }, { ...START, day: { tokens: 0, costUsd: 0.4, unpriced: 1 } });
    budget.add(used(100, 10), 0.2, 'Priced Model');
    expect(budget.exceeded()).toBe(
      'Paused at about $0.60 today, past the limit of $0.50 for one day set in Settings → Permissions. The amount comes from published prices and can differ from your bill; 1 request had no published price and is not in it.'
    );
    const more = new SpendBudget({ ...NO_SPEND_LIMITS, dayCostUsd: 0.5 }, { ...START, day: { tokens: 0, costUsd: 0.4, unpriced: 2 } });
    more.add(used(100, 10), 0.2, 'Priced Model');
    expect(more.exceeded()).toMatch(/; 2 requests had no published price and are not in it\.$/);
  });

  it('says once that a model with no published price is outside the cost limits, and counts its requests', () => {
    const budget = new SpendBudget({ ...NO_SPEND_LIMITS, sessionCostUsd: 1, dayCostUsd: 5 }, START);
    expect(budget.add(used(100, 10), null, 'Local Model')).toBe(
      "The cost limits for a session and a day can't follow Local Model: it has no published price. Its requests are counted in tokens only."
    );
    // Said once a turn, not with every request.
    expect(budget.add(used(100, 10), null, 'Local Model')).toBeNull();
  });

  it('names each cost limit the request is outside of: a session, a project, a day', () => {
    const one = new SpendBudget({ ...NO_SPEND_LIMITS, projectCostUsd: 1 }, START);
    expect(one.add(used(100, 10), null, 'Local Model')).toBe(
      "The cost limit for a project can't follow Local Model: it has no published price. Its requests are counted in tokens only."
    );
    const all = new SpendBudget({ ...NO_SPEND_LIMITS, sessionCostUsd: 1, projectCostUsd: 1, dayCostUsd: 5 }, START);
    expect(all.add(used(100, 10), null, 'Local Model')).toBe(
      "The cost limits for a session, a project and a day can't follow Local Model: it has no published price. Its requests are counted in tokens only."
    );
  });

  it('says nothing about prices when no cost limit is set', () => {
    const budget = new SpendBudget({ ...NO_SPEND_LIMITS, sessionTokens: 1_000_000 }, START);
    expect(budget.add(used(1000, 50), null, 'Local Model')).toBeNull();
  });

  it("names the first limit that was passed: the session's tokens, then the project's, then the day's", () => {
    const budget = new SpendBudget({ sessionTokens: 100, sessionCostUsd: 0.01, projectTokens: 100, projectCostUsd: 0.01, dayTokens: 100, dayCostUsd: 0.01 }, START);
    budget.add(used(1000, 0), 1, 'Priced Model');
    expect(budget.exceeded()).toMatch(/^Paused after about 1,000 tokens in this session/);
    const project = new SpendBudget({ ...NO_SPEND_LIMITS, projectTokens: 100, projectCostUsd: 0.01 }, START);
    project.add(used(1000, 0), 1, 'Priced Model');
    expect(project.exceeded()).toMatch(/^Paused after about 1,000 tokens in this project/);
    const day = new SpendBudget({ ...NO_SPEND_LIMITS, dayTokens: 100, dayCostUsd: 0.01 }, START);
    day.add(used(1000, 0), 1, 'Priced Model');
    expect(day.exceeded()).toMatch(/^Paused after about 1,000 tokens today/);
  });
});
