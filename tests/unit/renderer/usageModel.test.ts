import { describe, expect, it } from 'vitest';
import { cacheNote, costText, dayBars, dayLabel, usageMoney, usageName, usageView } from '../../../src/renderer/src/features/settings/usageModel';
import { MEDIA_USAGE, type UsageDay } from '../../../src/shared/usage';

const row = (day: string, modelId: string, extra: Partial<UsageDay> = {}): UsageDay => ({
  day,
  providerId: 'p1',
  modelId,
  requests: 1,
  usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  costUsd: 0.5,
  unpriced: 0,
  ...extra
});

const today = new Date(2026, 9, 10, 15);

describe('usage by day, as the Usage page shows it', () => {
  it('has every day of the range, oldest first, with nothing on the days nothing was used', () => {
    const view = usageView([row('2026-10-08', 'm1'), row('2026-10-10', 'm1'), row('2026-10-10', 'm2', { costUsd: 0.25 })], today, 7);
    expect(view.days.map((d) => d.day)).toEqual(['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10']);
    expect(view.days.map((d) => d.costUsd)).toEqual([0, 0, 0, 0, 0.5, 0, 0.75]);
    expect(view.days.at(-1)).toMatchObject({ requests: 2, sent: 200, output: 20, costUsd: 0.75, unpriced: 0 });
    expect(view.total).toMatchObject({ requests: 3, sent: 300, output: 30, costUsd: 1.25, unpriced: 0 });
  });

  it('leaves out what was used before the range began', () => {
    const view = usageView([row('2026-09-01', 'm1', { costUsd: 99 }), row('2026-10-10', 'm1')], today, 7);
    expect(view.total).toMatchObject({ requests: 1, costUsd: 0.5 });
    expect(view.models).toHaveLength(1);
  });

  it('counts everything sent to a model, cached or not, and says how much came from the cache', () => {
    const view = usageView([row('2026-10-10', 'm1', { usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 800, cacheWriteTokens: 100 } })], today, 7);
    expect(view.total).toMatchObject({ sent: 1000, cached: 800, output: 40 });
    expect(cacheNote(view.total)).toBe('80% read from cache');
    expect(cacheNote({ ...view.total, cached: 0 })).toBeNull();
  });

  it('lists the models by what they cost, then by what they used', () => {
    const view = usageView(
      [
        row('2026-10-09', 'cheap', { costUsd: 0.1 }),
        row('2026-10-10', 'cheap', { costUsd: 0.1 }),
        row('2026-10-10', 'dear', { costUsd: 3 }),
        row('2026-10-10', 'free-big', { costUsd: 0, unpriced: 1, usage: { inputTokens: 9000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
        row('2026-10-10', 'free-small', { costUsd: 0, unpriced: 1 })
      ],
      today,
      7
    );
    expect(view.models.map((m) => m.modelId)).toEqual(['dear', 'cheap', 'free-big', 'free-small']);
    expect(view.models[1]).toMatchObject({ requests: 2, costUsd: 0.2 });
  });

  it('keeps what a tool paid for out of the count of requests', () => {
    const view = usageView([row('2026-10-10', 'm1'), row('2026-10-10', MEDIA_USAGE.modelId, { providerId: MEDIA_USAGE.providerId, requests: 2, costUsd: 0.08, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } })], today, 7);
    expect(view.total).toMatchObject({ requests: 1, costUsd: 0.58 });
    // The pictures are still a line of their own, with how many were paid for.
    expect(view.models.find((m) => m.modelId === MEDIA_USAGE.modelId)).toMatchObject({ requests: 2, costUsd: 0.08 });
  });
});

describe('the bars of the Usage page', () => {
  const view = usageView([row('2026-10-08', 'm1', { costUsd: 2 }), row('2026-10-10', 'm1', { costUsd: 0.01 }), row('2026-10-09', 'm1', { costUsd: 0, unpriced: 1 })], today, 3);

  it('draws each day against the largest, with a sliver for a day that has anything at all', () => {
    const bars = dayBars(view.days, 'cost', 'en-US');
    expect(bars.map((b) => b.share)).toEqual([1, 0, 0.02]);
    expect(bars.map((b) => b.label)).toEqual(['Oct 8', 'Oct 9', 'Oct 10']);
  });

  it('measures tokens when asked, where a day with no known price still shows', () => {
    const bars = dayBars(view.days, 'tokens', 'en-US');
    expect(bars.map((b) => b.share)).toEqual([1, 1, 1]);
    expect(bars[1]!.value).toBe('110 tokens');
  });

  it('is flat when nothing was used', () => {
    expect(dayBars(usageView([], today, 3).days, 'cost', 'en-US').map((b) => b.share)).toEqual([0, 0, 0]);
  });

  it('reads a day out in full', () => {
    const bars = dayBars(view.days, 'cost', 'en-US');
    expect(bars[0]!.readout).toBe('Oct 8: $2.00 · 100 sent · 10 written · 1 request');
    expect(bars[1]!.readout).toBe('Oct 9: No published price · 100 sent · 10 written · 1 request');
    expect(dayBars(usageView([], today, 1).days, 'cost', 'en-US')[0]!.readout).toBe('Oct 10: nothing used');
  });
});

describe('money and names on the Usage page', () => {
  it('writes money to the cent, and says so when it is less', () => {
    expect(usageMoney(0)).toBe('$0.00');
    expect(usageMoney(0.004)).toBe('Less than $0.01');
    expect(usageMoney(0.016)).toBe('$0.02');
    expect(usageMoney(12.5)).toBe('$12.50');
    expect(usageMoney(1234.5)).toBe('$1,234.50');
  });

  it('never prices a request nobody published a price for', () => {
    const none = { requests: 0, sent: 0, cached: 0, output: 0, costUsd: 0, unpriced: 0 };
    expect(costText(none)).toBe('$0.00');
    expect(costText({ ...none, requests: 3, costUsd: 1.5 })).toBe('$1.50');
    expect(costText({ ...none, requests: 3, unpriced: 3 })).toBe('No published price');
    expect(costText({ ...none, requests: 3, costUsd: 1.5, unpriced: 1 })).toBe('$1.50, and 1 request with no published price');
    expect(costText({ ...none, requests: 5, costUsd: 1.5, unpriced: 2 })).toBe('$1.50, and 2 requests with no published price');
    // A free model is priced: it cost nothing, which is a price.
    expect(costText({ ...none, requests: 2, costUsd: 0 })).toBe('$0.00');
  });

  it('names a model by its label, its id when it is gone, and pictures as pictures', () => {
    const labels = { model: (providerId: string, modelId: string) => (modelId === 'm1' ? 'Model One' : null), provider: (id: string) => (id === 'p1' ? 'Provider One' : null) };
    expect(usageName({ providerId: 'p1', modelId: 'm1' }, labels)).toEqual({ model: 'Model One', provider: 'Provider One' });
    expect(usageName({ providerId: 'gone', modelId: 'old-model' }, labels)).toEqual({ model: 'old-model', provider: 'A provider that was removed' });
    expect(usageName(MEDIA_USAGE, labels)).toEqual({ model: 'Generated images', provider: 'Paid for by the image tool' });
  });

  it('labels a day by its date on this computer', () => {
    expect(dayLabel('2026-01-03', 'en-US')).toBe('Jan 3');
    expect(dayLabel('2026-12-31', 'en-US')).toBe('Dec 31');
  });
});
