import { z } from 'zod';
import { UsageSchema, type Usage } from './schemas/common';

/**
 * What Graft used on one day with one model. Counted as requests are made, from 0.6.16
 * on: a day before that has no row, and nothing is worked out for it afterwards.
 */
export const UsageDaySchema = z.object({
  /** The date on this computer when the request was made, as YYYY-MM-DD. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  providerId: z.string(),
  modelId: z.string(),
  requests: z.number().int().nonnegative(),
  usage: UsageSchema,
  /** What the requests with a known price cost. */
  costUsd: z.number().nonnegative(),
  /** Requests whose price nobody published: they are counted, and their cost is not in `costUsd`. */
  unpriced: z.number().int().nonnegative()
});
export type UsageDay = z.infer<typeof UsageDaySchema>;

/** One request, or one thing a tool paid for, as it is added to its day. A null cost means the price is not known. */
export interface UsageEntry {
  day: string;
  providerId: string;
  modelId: string;
  usage: Usage;
  costUsd: number | null;
}

/** Where money a tool spent is counted (a generated image): it has a price and no tokens. */
export const MEDIA_USAGE = { providerId: 'graft', modelId: 'generated-images' } as const;

const two = (n: number): string => String(n).padStart(2, '0');

/** The day a moment belongs to: the date on this computer, which is the day the user means by "today". */
export function usageDay(date: Date): string {
  return `${String(date.getFullYear())}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** The last `count` days up to and including `today`, oldest first. */
export function daysBack(today: Date, count: number): string[] {
  const days: string[] = [];
  for (let back = count - 1; back >= 0; back--) {
    // Noon, so a day of 23 or 25 hours can't push the date off by one.
    days.push(usageDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - back, 12)));
  }
  return days;
}
