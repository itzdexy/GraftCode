import type { Usage } from '@shared/schemas/common';

/** Limits for one turn, everything it starts included (sub-agents, groups, generated pictures); null means none. */
export interface TurnLimits {
  tokens: number | null;
  costUsd: number | null;
  minutes: number | null;
}

/** Tokens that cost money: what was sent and written, with cache reads at the tenth they are billed at. */
export function spentTokens(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens + Math.round(usage.cacheReadTokens / 10);
}

const WHERE = 'for one turn set in Settings → Permissions';

/**
 * What one turn has used, against its limits. One of these is shared by the turn's own loop
 * and every loop it starts, so the limits hold for the whole of the work and not for each
 * agent on its own. Tokens and cost are estimates and are worded as such: cache reads are
 * weighted, and cost comes from published prices. A request whose price nobody published
 * can't be followed by the cost limit; that is said once, and counted when the turn pauses.
 */
export class TurnBudget {
  private tokens = 0;
  private costUsd = 0;
  private unpriced = 0;
  private readonly startedAt: number;
  private waitedMs = 0;
  private waitingSince: number | null = null;

  constructor(
    private readonly limits: TurnLimits,
    private readonly now: () => number = Date.now
  ) {
    this.startedAt = now();
  }

  /**
   * One request's usage, from the turn itself or from an agent it started. Returns a line
   * for the user when the cost limit can't follow this request, the first time that happens.
   */
  add(usage: Usage, costUsd: number | null, modelLabel: string): string | null {
    this.tokens += spentTokens(usage);
    if (costUsd !== null) {
      this.costUsd += costUsd;
      return null;
    }
    this.unpriced++;
    if (this.unpriced > 1 || this.limits.costUsd === null) return null;
    return `The cost limit for one turn can't follow ${modelLabel}: it has no published price. Its requests are counted in tokens and time only.`;
  }

  /** Money a tool spent on the user's key (a generated picture). */
  spend(costUsd: number): void {
    this.costUsd += costUsd;
  }

  /** The turn is waiting for the user (an approval, a question): that time is theirs, not the turn's. */
  waiting(on: boolean): void {
    if (on) {
      this.waitingSince ??= this.now();
      return;
    }
    if (this.waitingSince === null) return;
    this.waitedMs += this.now() - this.waitingSince;
    this.waitingSince = null;
  }

  private workedMs(): number {
    const waitingNow = this.waitingSince === null ? 0 : this.now() - this.waitingSince;
    return this.now() - this.startedAt - this.waitedMs - waitingNow;
  }

  /** Why the turn has to pause now, or null while it is within its limits. */
  exceeded(): string | null {
    const { tokens, costUsd, minutes } = this.limits;
    if (tokens !== null && this.tokens > tokens) {
      return `Paused after about ${this.tokens.toLocaleString('en-US')} tokens, past the limit of ${tokens.toLocaleString('en-US')} ${WHERE}.`;
    }
    if (costUsd !== null && this.costUsd > costUsd) {
      const left = this.unpriced > 0 ? `; ${String(this.unpriced)} ${this.unpriced === 1 ? 'request' : 'requests'} had no published price and ${this.unpriced === 1 ? 'is' : 'are'} not in it` : '';
      return `Paused at about $${this.costUsd.toFixed(2)}, past the limit of $${costUsd.toFixed(2)} ${WHERE}. The amount comes from published prices and can differ from your bill${left}.`;
    }
    if (minutes !== null && this.workedMs() >= minutes * 60_000) {
      return `Paused after ${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'} of work, the limit ${WHERE}.`;
    }
    return null;
  }
}
