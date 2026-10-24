import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChartColumn } from 'lucide-react';
import { daysBack } from '@shared/usage';
import { Button } from '../../components/Button';
import { Collapse } from '../../components/Collapse';
import { Segmented } from '../../components/Segmented';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { cn } from '../../lib/cn';
import { formatTokenCount } from '../../lib/format';
import { invoke } from '../../lib/ipc';
import { useLoad } from '../../lib/useLoad';
import { findModel, useApp } from '../../stores/app';
import { Group } from './common';
import { cacheNote, costText, dayBars, isMediaUsage, USAGE_RANGES, usageMoney, usageName, usageView, type DayBar, type DayUsage, type ModelUsage, type UsageMetric, type UsageRange, type UsageTotal } from './usageModel';

const LONGEST = USAGE_RANGES[USAGE_RANGES.length - 1] ?? 90;

function Tile({ label, value, note }: { label: string; value: string; note?: string | undefined }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 bg-raised px-14 py-12">
      <dt className="text-sm text-fg-muted">{label}</dt>
      <dd className="text-xl font-medium text-fg-strong tabular-nums">{value}</dd>
      {note ? <dd className="text-sm text-fg-muted">{note}</dd> : null}
    </div>
  );
}

function Totals({ total }: { total: UsageTotal }) {
  const allUnpriced = total.costUsd === 0 && total.unpriced > 0 && total.unpriced >= total.requests;
  return (
    <dl aria-label="Totals" className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border-card bg-border-subtle @[560px]:grid-cols-4">
      <Tile
        label="Spent"
        value={allUnpriced ? 'Unknown' : usageMoney(total.costUsd)}
        note={
          allUnpriced
            ? 'No published price for these models'
            : total.unpriced > 0
              ? `Not counting ${String(total.unpriced)} ${total.unpriced === 1 ? 'request' : 'requests'} with no published price`
              : undefined
        }
      />
      <Tile label="Sent to models" value={formatTokenCount(total.sent)} note={cacheNote(total) ?? undefined} />
      <Tile label="Written by models" value={formatTokenCount(total.output)} />
      <Tile label="Requests" value={total.requests.toLocaleString('en-US')} />
    </dl>
  );
}

/**
 * The days as bars. One stop for the keyboard: the arrow keys walk the days and the line
 * above reads the chosen one out, which is also what a pointer over a bar shows.
 */
function DayChart({ bars, metric, range }: { bars: DayBar[]; metric: UsageMetric; range: UsageRange }) {
  const [picked, setPicked] = useState<number | null>(null);
  const readoutId = useId();
  const tallest = bars.reduce<DayBar | null>((best, bar) => (bar.share > (best?.share ?? 0) ? bar : best), null);
  const resting = tallest ? `Most on ${tallest.label}: ${tallest.value}` : metric === 'cost' ? 'Nothing used in these days has a published price.' : 'Nothing used in these days.';
  const chosen = picked !== null ? bars[picked] : undefined;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const last = bars.length - 1;
    const next =
      event.key === 'ArrowLeft'
        ? Math.max(0, (picked ?? bars.length) - 1)
        : event.key === 'ArrowRight'
          ? Math.min(last, (picked ?? -1) + 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (event.key === 'Escape') setPicked(null);
    if (next === null) return;
    event.preventDefault();
    setPicked(next);
  };

  const marks = [bars[0], bars[Math.floor((bars.length - 1) / 2)], bars[bars.length - 1]];
  return (
    <div className="flex flex-col gap-8 px-14 py-12">
      <p id={readoutId} aria-live="polite" className="min-h-[1lh] text-sm text-fg-secondary tabular-nums">
        {chosen ? chosen.readout : resting}
      </p>
      <div
        role="group"
        tabIndex={0}
        aria-label={`${metric === 'cost' ? 'Cost' : 'Tokens'} for each of the last ${String(range)} days. The left and right arrow keys read a day out.`}
        aria-describedby={readoutId}
        onKeyDown={onKeyDown}
        onBlur={() => setPicked(null)}
        onMouseLeave={() => setPicked(null)}
        className="rounded-sm"
      >
        <div className="flex h-[112px] items-stretch border-b border-border-subtle">
          {bars.map((bar, index) => (
            <div
              key={bar.day}
              onMouseEnter={() => setPicked(index)}
              className={cn('flex min-w-0 flex-1 items-end justify-center px-[1px] transition-ui', picked === index && 'bg-hover')}
            >
              <div className="w-full max-w-[18px] rounded-t-[2px] bg-blue" style={{ height: `${String(bar.share * 100)}%` }} />
            </div>
          ))}
        </div>
        <div aria-hidden="true" className="mt-4 flex justify-between text-xs text-fg-muted tabular-nums">
          {marks.map((mark, index) => (
            <span key={index}>{mark?.label ?? ''}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

const HEAD = 'px-14 py-8 text-sm font-medium text-fg-muted';
const CELL = 'px-14 py-8 text-sm text-fg-secondary tabular-nums';

function NumbersTable({ caption, first, rows }: { caption: string; first: string; rows: Array<{ key: string; name: ReactNode; requests: string; used: UsageTotal }> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border-subtle">
            <th scope="col" className={cn(HEAD, 'text-left')}>
              {first}
            </th>
            {['Requests', 'Sent', 'Written', 'Cost'].map((heading) => (
              <th key={heading} scope="col" className={cn(HEAD, 'text-right')}>
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row" className="px-14 py-8 text-left text-sm font-normal text-fg">
                {row.name}
              </th>
              <td className={cn(CELL, 'text-right')}>{row.requests}</td>
              <td className={cn(CELL, 'text-right')}>{formatTokenCount(row.used.sent)}</td>
              <td className={cn(CELL, 'text-right')}>{formatTokenCount(row.used.output)}</td>
              <td className={cn(CELL, 'max-w-[220px] text-right')}>{costText(row.used)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ByModel({ models }: { models: ModelUsage[] }) {
  const known = useApp((s) => s.models);
  const providers = useApp((s) => s.providers);
  const labels = {
    model: (providerId: string, modelId: string) => findModel({ models: known }, { providerId, modelId })?.label ?? null,
    provider: (providerId: string) => providers.find((p) => p.id === providerId)?.label ?? null
  };
  return (
    <NumbersTable
      caption="What each model used in these days"
      first="Model"
      rows={models.map((model) => {
        const name = usageName(model, labels);
        return {
          key: `${model.providerId}/${model.modelId}`,
          name: (
            <>
              <span className="block truncate">{name.model}</span>
              <span className="block truncate text-fg-muted">{name.provider}</span>
            </>
          ),
          requests: isMediaUsage(model) ? `${String(model.requests)} ${model.requests === 1 ? 'picture' : 'pictures'}` : model.requests.toLocaleString('en-US'),
          used: model
        };
      })}
    />
  );
}

function ByDay({ days, bars }: { days: DayUsage[]; bars: DayBar[] }) {
  const labels = new Map(bars.map((bar) => [bar.day, bar.label]));
  const used = days.filter((day) => day.requests > 0 || day.costUsd > 0).reverse();
  return (
    <NumbersTable
      caption="What was used on each day, newest first"
      first="Day"
      rows={used.map((day) => ({ key: day.day, name: labels.get(day.day) ?? day.day, requests: day.requests.toLocaleString('en-US'), used: day }))}
    />
  );
}

export function UsageSection() {
  const [range, setRange] = useState<UsageRange>(30);
  const [metric, setMetric] = useState<UsageMetric>('cost');
  const [table, setTable] = useState(false);
  const tableId = useId();
  // The longest range is loaded once; a shorter one is a view of the same rows.
  const { load, reload } = useLoad(() => invoke('usage:days', { fromDay: daysBack(new Date(), LONGEST)[0] ?? '' }), 'usage');

  const controls = (
    <div className="flex flex-wrap items-center justify-between gap-12">
      <Segmented
        variant="composer"
        label="Days shown"
        value={String(range)}
        options={USAGE_RANGES.map((days) => ({ value: String(days), label: `${String(days)} days` }))}
        onChange={(value) => setRange(Number(value) as UsageRange)}
      />
      <Button size="sm" variant="ghost" onClick={reload}>
        Refresh
      </Button>
    </div>
  );

  if (load.status === 'loading') {
    return (
      <div className="flex flex-col gap-24">
        {controls}
        <LoadingState label="Adding up what was used…" />
      </div>
    );
  }
  if (load.status === 'error') {
    return (
      <div className="flex flex-col gap-24">
        {controls}
        <ErrorState title="Couldn't load what was used" message={load.message} onRetry={reload} />
      </div>
    );
  }

  const view = usageView(load.data, new Date(), range);
  const bars = dayBars(view.days, metric);
  const nothing = view.total.requests === 0 && view.total.costUsd === 0;
  return (
    <div className="@container flex flex-col gap-24">
      {controls}
      {nothing ? (
        <div className="rounded-lg border border-border-card bg-raised">
          <EmptyState
            icon={<ChartColumn className="size-20" aria-hidden="true" />}
            title={`Nothing used in the last ${String(range)} days`}
            description="Graft counts each request as it is made. Sessions from before version 0.6.16 kept one total for the whole session, so their days are not here."
          />
        </div>
      ) : (
        <>
          <Totals total={view.total} />
          <Group
            title="By day"
            actions={
              <Segmented
                variant="composer"
                label="What the bars measure"
                value={metric}
                options={[
                  { value: 'cost', label: 'Cost' },
                  { value: 'tokens', label: 'Tokens' }
                ]}
                onChange={setMetric}
              />
            }
          >
            <DayChart bars={bars} metric={metric} range={range} />
            <div className="px-6 py-6">
              <Button size="sm" variant="ghost" aria-expanded={table} aria-controls={tableId} onClick={() => setTable(!table)}>
                {table ? 'Hide the table' : 'Show the days as a table'}
              </Button>
              <div id={tableId}>
                <Collapse open={table}>
                  <ByDay days={view.days} bars={bars} />
                </Collapse>
              </div>
            </div>
          </Group>
          <Group title="By model">
            <ByModel models={view.models} />
          </Group>
        </>
      )}
      <p className="text-sm text-fg-muted">
        Counted from version 0.6.16 on, as requests are made. Costs come from each provider’s published prices, so a bill can differ. Incognito chats are not counted.
      </p>
    </div>
  );
}
