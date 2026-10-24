import type { Usage } from '@shared/schemas/common';

/** Limits for one turn, everything it starts included (sub-agents, groups, generated pictures); null means none. */
export interface TurnLimits {
  tokens: number | null;
  costUsd: number | null;
  minutes: number | null;
  /** Tool calls started, by the turn and by the agents it started. */
  toolCalls: number | null;
  /** Times a failed request was sent again. */
  retries: number | null;
}

/** Tokens that cost money: what was sent and written, with cache reads at the tenth they are billed at. */
export function spentTokens(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens + Math.round(usage.cacheReadTokens / 10);
}

/** Limits that hold across turns: everything one session has used, everything the sessions of one project have used, and everything used today on this computer; null means none. */
export interface SpendLimits {
  sessionTokens: number | null;
  sessionCostUsd: number | null;
  projectTokens: number | null;
  projectCostUsd: number | null;
  dayTokens: number | null;
  dayCostUsd: number | null;
}

/** What a session, its project and a day had already used when the turn started; the turn's own requests are added to it. */
export interface SpendStart {
  session: { tokens: number; costUsd: number };
  project: { tokens: number; costUsd: number };
  day: { tokens: number; costUsd: number; unpriced: number };
}

/** "a session", "a session and a day", "a session, a project and a day": what the cost limits are, for the note below. */
function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
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
  private toolCalls = 0;
  private retries = 0;
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

  /** A tool call started, in the turn's own loop or an agent's. */
  toolCall(): void {
    this.toolCalls++;
  }

  /** A failed request is about to be sent again. The one that goes past the limit is refused (see exceeded). */
  retry(): void {
    this.retries++;
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
    const { tokens, costUsd, minutes, toolCalls, retries } = this.limits;
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
    if (toolCalls !== null && this.toolCalls >= toolCalls) {
      // A reply can ask for several calls at once, and they all run before the turn can be paused.
      const made = `${this.toolCalls.toLocaleString('en-US')} tool ${this.toolCalls === 1 ? 'call' : 'calls'}`;
      return this.toolCalls === toolCalls ? `Paused after ${made}, the limit ${WHERE}.` : `Paused after ${made}, past the limit of ${toolCalls.toLocaleString('en-US')} ${WHERE}.`;
    }
    if (retries !== null && this.retries > retries) {
      return `Paused after ${String(retries)} ${retries === 1 ? 'retry of a failed request' : 'retries of failed requests'}, the limit ${WHERE}.`;
    }
    return null;
  }
}

/**
 * What a session, its project and the day have used, against their limits: the roll-up a per-turn budget
 * cannot give. The session's own total comes from its usage, the project's from the totals of the project's
 * sessions, the day's from the usage by day that Settings → Usage shows. Seeded when a turn starts and added
 * to as its requests arrive, so what a turn spends counts against the session, the project and the day at
 * once. Reaching a limit pauses the turn like any other.
 */
export class SpendBudget {
  private sessionTokens: number;
  private sessionCostUsd: number;
  private projectTokens: number;
  private projectCostUsd: number;
  private dayTokens: number;
  private dayCostUsd: number;
  private dayUnpriced: number;
  /** Requests this turn whose price nobody published, counted for the note below. */
  private unpriced = 0;

  constructor(
    private readonly limits: SpendLimits,
    start: SpendStart
  ) {
    this.sessionTokens = start.session.tokens;
    this.sessionCostUsd = start.session.costUsd;
    this.projectTokens = start.project.tokens;
    this.projectCostUsd = start.project.costUsd;
    this.dayTokens = start.day.tokens;
    this.dayCostUsd = start.day.costUsd;
    this.dayUnpriced = start.day.unpriced;
  }

  /** One request's usage. Returns a line for the user when a cost limit can't follow this request, the first time that happens. */
  add(usage: Usage, costUsd: number | null, modelLabel: string): string | null {
    const tokens = spentTokens(usage);
    this.sessionTokens += tokens;
    this.projectTokens += tokens;
    this.dayTokens += tokens;
    if (costUsd !== null) {
      this.sessionCostUsd += costUsd;
      this.projectCostUsd += costUsd;
      this.dayCostUsd += costUsd;
      return null;
    }
    this.unpriced++;
    this.dayUnpriced++;
    const costLimits = [
      ...(this.limits.sessionCostUsd === null ? [] : ['a session']),
      ...(this.limits.projectCostUsd === null ? [] : ['a project']),
      ...(this.limits.dayCostUsd === null ? [] : ['a day'])
    ];
    if (this.unpriced > 1 || costLimits.length === 0) return null;
    return `The cost limit${costLimits.length === 1 ? '' : 's'} for ${listOf(costLimits)} can't follow ${modelLabel}: it has no published price. Its requests are counted in tokens only.`;
  }

  /** Money a tool spent on the user's key (a generated picture). */
  spend(costUsd: number): void {
    this.sessionCostUsd += costUsd;
    this.projectCostUsd += costUsd;
    this.dayCostUsd += costUsd;
  }

  /** Why the turn has to pause now, or null while the session, its project and the day are within their limits. */
  exceeded(): string | null {
    const { sessionTokens, sessionCostUsd, projectTokens, projectCostUsd, dayTokens, dayCostUsd } = this.limits;
    if (sessionTokens !== null && this.sessionTokens > sessionTokens) {
      return `Paused after about ${this.sessionTokens.toLocaleString('en-US')} tokens in this session, past the limit of ${sessionTokens.toLocaleString('en-US')} for one session set in Settings → Permissions.`;
    }
    if (sessionCostUsd !== null && this.sessionCostUsd > sessionCostUsd) {
      return `Paused at about $${this.sessionCostUsd.toFixed(2)} for this session, past the limit of $${sessionCostUsd.toFixed(2)} for one session set in Settings → Permissions. The amount comes from published prices and can differ from your bill.`;
    }
    if (projectTokens !== null && this.projectTokens > projectTokens) {
      return `Paused after about ${this.projectTokens.toLocaleString('en-US')} tokens in this project, past the limit of ${projectTokens.toLocaleString('en-US')} for one project set in Settings → Permissions.`;
    }
    if (projectCostUsd !== null && this.projectCostUsd > projectCostUsd) {
      return `Paused at about $${this.projectCostUsd.toFixed(2)} for this project, past the limit of $${projectCostUsd.toFixed(2)} for one project set in Settings → Permissions. The amount comes from published prices and can differ from your bill.`;
    }
    if (dayTokens !== null && this.dayTokens > dayTokens) {
      return `Paused after about ${this.dayTokens.toLocaleString('en-US')} tokens today, past the limit of ${dayTokens.toLocaleString('en-US')} for one day set in Settings → Permissions.`;
    }
    if (dayCostUsd !== null && this.dayCostUsd > dayCostUsd) {
      const left =
        this.dayUnpriced > 0
          ? `; ${String(this.dayUnpriced)} ${this.dayUnpriced === 1 ? 'request had' : 'requests had'} no published price and ${this.dayUnpriced === 1 ? 'is' : 'are'} not in it`
          : '';
      return `Paused at about $${this.dayCostUsd.toFixed(2)} today, past the limit of $${dayCostUsd.toFixed(2)} for one day set in Settings → Permissions. The amount comes from published prices and can differ from your bill${left}.`;
    }
    return null;
  }
}
