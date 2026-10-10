import { daysBack, MEDIA_USAGE, type UsageDay } from '@shared/usage';
import { formatTokenCount } from '../../lib/format';

export const USAGE_RANGES = [7, 30, 90] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];
export type UsageMetric = 'cost' | 'tokens';

/** What a day, a model or a whole range used. */
export interface UsageTotal {
  requests: number;
  /** Everything that went to the model, cached or not. */
  sent: number;
  /** The part of `sent` the provider read from its cache. */
  cached: number;
  /** What the model wrote. */
  output: number;
  /** What the requests with a known price cost. */
  costUsd: number;
  /** Requests nobody published a price for: counted, never priced. */
  unpriced: number;
}

export interface DayUsage extends UsageTotal {
  day: string;
}

export interface ModelUsage extends UsageTotal {
  providerId: string;
  modelId: string;
}

export interface UsageView {
  /** Every day of the range, oldest first; a day nothing was used on is there with zeros. */
  days: DayUsage[];
  /** What cost most first, then what used most. */
  models: ModelUsage[];
  total: UsageTotal;
}

const NOTHING: UsageTotal = { requests: 0, sent: 0, cached: 0, output: 0, costUsd: 0, unpriced: 0 };

/** What a tool paid for (a generated picture): money with no tokens, kept apart from requests to a model. */
export function isMediaUsage(row: { providerId: string; modelId: string }): boolean {
  return row.providerId === MEDIA_USAGE.providerId && row.modelId === MEDIA_USAGE.modelId;
}

/** Sums of money are kept to a millionth of a dollar, so cents never show a rounding tail. */
function dollars(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function add(total: UsageTotal, row: UsageDay, countRequests: boolean): UsageTotal {
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = row.usage;
  return {
    requests: total.requests + (countRequests ? row.requests : 0),
    sent: total.sent + inputTokens + cacheReadTokens + cacheWriteTokens,
    cached: total.cached + cacheReadTokens,
    output: total.output + outputTokens,
    costUsd: dollars(total.costUsd + row.costUsd),
    unpriced: total.unpriced + row.unpriced
  };
}

/** The rows of the last `range` days up to `today`, added up by day, by model and altogether. */
export function usageView(rows: UsageDay[], today: Date, range: number): UsageView {
  const days = new Map<string, UsageTotal>(daysBack(today, range).map((day) => [day, NOTHING]));
  const models = new Map<string, ModelUsage>();
  let total = NOTHING;
  for (const row of rows) {
    const day = days.get(row.day);
    if (!day) continue;
    // A picture a tool paid for is money spent, not a request to a model.
    const request = !isMediaUsage(row);
    days.set(row.day, add(day, row, request));
    total = add(total, row, request);
    const key = `${row.providerId}\n${row.modelId}`;
    models.set(key, { ...add(models.get(key) ?? NOTHING, row, true), providerId: row.providerId, modelId: row.modelId });
  }
  return {
    days: [...days].map(([day, used]) => ({ day, ...used })),
    models: [...models.values()].sort((a, b) => b.costUsd - a.costUsd || b.sent + b.output - (a.sent + a.output)),
    total
  };
}

/** Money to the cent; an amount under a cent says so instead of reading as nothing. */
export function usageMoney(usd: number): string {
  if (usd > 0 && usd < 0.005) return 'Less than $0.01';
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** What something cost, without a price for requests that have none. */
export function costText(used: UsageTotal): string {
  if (used.unpriced === 0) return usageMoney(used.costUsd);
  if (used.costUsd === 0 && used.unpriced >= used.requests) return 'No published price';
  return `${usageMoney(used.costUsd)}, and ${String(used.unpriced)} ${used.unpriced === 1 ? 'request' : 'requests'} with no published price`;
}

/** How much of what was sent the provider read from its cache, which it bills at a fraction; null when none was. */
export function cacheNote(used: UsageTotal): string | null {
  return used.cached > 0 && used.sent > 0 ? `${String(Math.round((used.cached / used.sent) * 100))}% read from cache` : null;
}

/** "Oct 7" for a stored day, read as a date on this computer. */
export function dayLabel(day: string, locale?: string): string {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(year, month - 1, date));
}

export interface DayBar {
  day: string;
  label: string;
  /** The day's amount in the measure the bars use ("$1.20", "340K tokens"). */
  value: string;
  /** The bar's height, 0..1 of the largest day. */
  share: number;
  /** The whole day in a sentence, for the line above the chart and for screen readers. */
  readout: string;
}

/**
 * The days as bars, each drawn against the largest day. A day with anything at all gets a
 * sliver, so a small day never looks like an empty one.
 */
export function dayBars(days: DayUsage[], metric: UsageMetric, locale?: string): DayBar[] {
  const amount = (day: DayUsage): number => (metric === 'cost' ? day.costUsd : day.sent + day.output);
  const largest = Math.max(0, ...days.map(amount));
  return days.map((day) => {
    const label = dayLabel(day.day, locale);
    const used = day.requests > 0 || day.costUsd > 0;
    return {
      day: day.day,
      label,
      value: metric === 'cost' ? costText(day) : `${formatTokenCount(day.sent + day.output)} tokens`,
      share: largest > 0 && amount(day) > 0 ? Math.max(0.02, Math.round((amount(day) / largest) * 100) / 100) : 0,
      readout: used
        ? `${label}: ${costText(day)} · ${formatTokenCount(day.sent)} sent · ${formatTokenCount(day.output)} written · ${String(day.requests)} ${day.requests === 1 ? 'request' : 'requests'}`
        : `${label}: nothing used`
    };
  });
}

/** How a row of usage is named: the model's label while Graft still knows it, and the picture tool's spending as what it is. */
export function usageName(
  row: { providerId: string; modelId: string },
  labels: { model(providerId: string, modelId: string): string | null; provider(providerId: string): string | null }
): { model: string; provider: string } {
  if (isMediaUsage(row)) return { model: 'Generated images', provider: 'Paid for by the image tool' };
  return { model: labels.model(row.providerId, row.modelId) ?? row.modelId, provider: labels.provider(row.providerId) ?? 'A provider that was removed' };
}
