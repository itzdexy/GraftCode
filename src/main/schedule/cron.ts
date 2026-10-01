import { GraftError } from '@shared/errors';

/**
 * Five-field cron expressions ("minute hour day-of-month month day-of-week")
 * evaluated in local time. Supports *, n, a-b, lists, steps (*\/15, 1-30/5),
 * month and weekday names, and 7 as Sunday. As in cron, when both day fields
 * are restricted a day matches if either does.
 */

interface Field {
  values: Set<number>;
  any: boolean;
}

export interface Cron {
  minute: Field;
  hour: Field;
  day: Field;
  month: Field;
  weekday: Field;
  source: string;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseValue(token: string, names: string[] | null, offset: number): number {
  const lower = token.toLowerCase();
  if (names) {
    const index = names.indexOf(lower);
    if (index >= 0) return index + offset;
  }
  if (!/^\d+$/.test(token)) throw new GraftError('invalid_cron', `"${token}" is not a number.`);
  return Number(token);
}

function parseField(text: string, min: number, max: number, names: string[] | null = null, nameOffset = 0): Field {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const [range = '', stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new GraftError('invalid_cron', `"${part}" has an invalid step.`);
    let start: number;
    let end: number;
    if (range === '*') {
      start = min;
      end = max;
    } else if (range.includes('-')) {
      const [a = '', b = ''] = range.split('-');
      start = parseValue(a, names, nameOffset);
      end = parseValue(b, names, nameOffset);
    } else {
      start = parseValue(range, names, nameOffset);
      end = stepText === undefined ? start : max;
    }
    if (start < min || end > max || start > end) throw new GraftError('invalid_cron', `"${part}" is out of range (${min}–${max}).`);
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return { values, any: text === '*' };
}

export function parseCron(expression: string): Cron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new GraftError('invalid_cron', 'Use five fields: minute hour day-of-month month day-of-week.');
  const [m = '', h = '', dom = '', mon = '', dow = ''] = fields;
  const weekday = parseField(dow, 0, 7, DAYS, 0);
  if (weekday.values.has(7)) {
    weekday.values.delete(7);
    weekday.values.add(0);
  }
  return {
    minute: parseField(m, 0, 59),
    hour: parseField(h, 0, 23),
    day: parseField(dom, 1, 31),
    month: parseField(mon, 1, 12, MONTHS, 1),
    weekday,
    source: fields.join(' ')
  };
}

function dayMatches(cron: Cron, date: Date): boolean {
  const dom = cron.day.values.has(date.getDate());
  const dow = cron.weekday.values.has(date.getDay());
  if (cron.day.any && cron.weekday.any) return true;
  if (cron.day.any) return dow;
  if (cron.weekday.any) return dom;
  return dom || dow;
}

/** First matching minute strictly after `after` (null if none within ~4 years, e.g. "31 2 * *"). */
export function nextRun(cron: Cron, after: Date): Date | null {
  const t = new Date(after.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = after.getTime() + 4 * 366 * 24 * 60 * 60 * 1000;
  while (t.getTime() <= limit) {
    if (!cron.month.values.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(cron, t)) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hour.values.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!cron.minute.values.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0);
      continue;
    }
    return t;
  }
  return null;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Plain-language description for common shapes; the expression otherwise. */
export function describeCron(expression: string): string {
  let cron: Cron;
  try {
    cron = parseCron(expression);
  } catch {
    return expression;
  }
  const single = (f: Field): number | null => (f.values.size === 1 ? ([...f.values][0] ?? null) : null);
  const minute = single(cron.minute);
  const hour = single(cron.hour);
  const time = minute !== null && hour !== null ? `${pad(hour)}:${pad(minute)}` : null;
  if (cron.day.any && cron.month.any) {
    if (minute !== null && cron.hour.any && cron.weekday.any) return minute === 0 ? 'Every hour' : `Every hour at :${pad(minute)}`;
    if (time && cron.weekday.any) return `Every day at ${time}`;
    const days = [...cron.weekday.values].sort();
    if (time && days.join(',') === '1,2,3,4,5') return `Weekdays at ${time}`;
    if (time && days.length === 1) {
      const name = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][days[0] ?? 0];
      return `Every ${name ?? ''} at ${time}`;
    }
  }
  return expression;
}
