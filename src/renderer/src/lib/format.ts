import type { EffortLevel, PermissionMode } from '@shared/schemas/common';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** Compact relative time as in the session lists: "now", "6m ago", "2d ago", "4w ago". */
export function relativeTime(timestamp: number, now: number = Date.now()): string {
  const delta = Math.max(0, now - timestamp);
  if (delta < MINUTE) return 'now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < WEEK) return `${Math.floor(delta / DAY)}d ago`;
  if (delta < MONTH) return `${Math.floor(delta / WEEK)}w ago`;
  if (delta < YEAR) return `${Math.floor(delta / MONTH)}mo ago`;
  return `${Math.floor(delta / YEAR)}y ago`;
}

export function partOfDay(date: Date): 'morning' | 'afternoon' | 'evening' {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  return 'evening';
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  none: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  extra: 'Extra',
  max: 'Max',
  taproot: 'Taproot'
};

export const PERMISSION_MODE_INFO: Record<PermissionMode, { label: string; description: string }> = {
  ask: { label: 'Ask', description: 'Ask before editing files or running commands' },
  'auto-edit': { label: 'Auto-edit', description: 'Edit project files freely; ask before commands' },
  plan: { label: 'Plan', description: 'Read and plan only until you approve a plan' },
  auto: { label: 'Auto', description: 'Approve low-risk actions; ask about anything risky' },
  bypass: { label: 'Bypass', description: 'Run everything without asking; only deny rules still block' }
};

/** Last path segment, for folder chips and group headers. */
export function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/** Shortens long paths from the middle: "C:\Users\me\…\project". */
export function shortenPath(p: string, max = 48): string {
  if (p.length <= max) return p;
  const keep = Math.max(8, Math.floor((max - 1) / 2));
  return `${p.slice(0, keep)}…${p.slice(p.length - keep)}`;
}
