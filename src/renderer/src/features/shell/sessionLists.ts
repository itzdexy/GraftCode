import type { SessionKind, SessionSummary } from '@shared/schemas/sessions';

/** Pure list logic for the sidebar and home screens (kept free of stores for testing). */

export type StatusFilter = 'all' | 'attention' | 'running' | 'idle' | 'archived';
export type DateFilter = 'any' | 'day' | 'week' | 'month';

export interface SessionFilter {
  status: StatusFilter;
  /** Project path (code mode only); null for all projects. */
  project: string | null;
  date: DateFilter;
}

export const DEFAULT_FILTER: SessionFilter = { status: 'all', project: null, date: 'any' };

const DAY = 24 * 60 * 60 * 1000;
const DATE_WINDOW: Record<DateFilter, number> = { any: Infinity, day: DAY, week: 7 * DAY, month: 30 * DAY };

export function needsAttention(s: SessionSummary): boolean {
  return s.status === 'needs-input' || s.status === 'error' || s.unread;
}

export function matchesFilter(s: SessionSummary, filter: SessionFilter, now: number): boolean {
  if (filter.status === 'archived' ? !s.archived : s.archived) return false;
  if (filter.status === 'attention' && !needsAttention(s)) return false;
  if (filter.status === 'running' && s.status !== 'running') return false;
  if (filter.status === 'idle' && (s.status !== 'idle' || s.unread)) return false;
  if (filter.project !== null && s.projectPath !== filter.project) return false;
  return now - s.updatedAt <= DATE_WINDOW[filter.date];
}

/** Pinned first, then most recently updated. */
export function byPinThenRecency(a: SessionSummary, b: SessionSummary): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return b.updatedAt - a.updatedAt;
}

export function visibleSessions(all: SessionSummary[], kind: SessionKind, filter: SessionFilter, now: number): SessionSummary[] {
  return all.filter((s) => s.kind === kind && matchesFilter(s, filter, now)).sort(byPinThenRecency);
}

export interface ProjectGroup {
  key: string;
  path: string | null;
  name: string;
  /** Shown after the name when two groups share one ("name · path"). */
  detail: string | null;
  sessions: SessionSummary[];
}

function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Groups code sessions by project folder, alphabetically by folder name. */
export function groupByProject(sessions: SessionSummary[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const s of sessions) {
    const key = s.projectPath ?? '';
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        path: s.projectPath,
        name: s.projectName ?? (s.projectPath ? folderName(s.projectPath) : 'No folder'),
        detail: null,
        sessions: []
      };
      groups.set(key, group);
    }
    group.sessions.push(s);
  }
  const list = [...groups.values()];
  const nameCounts = new Map<string, number>();
  for (const g of list) nameCounts.set(g.name.toLowerCase(), (nameCounts.get(g.name.toLowerCase()) ?? 0) + 1);
  for (const g of list) if ((nameCounts.get(g.name.toLowerCase()) ?? 0) > 1 && g.path) g.detail = g.path;
  for (const g of list) g.sessions.sort(byPinThenRecency);
  return list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.path ?? '').localeCompare(b.path ?? ''));
}

/** Home list: attention first (needs input, error, running, unread), then most recent. */
export function attentionRank(s: SessionSummary): number {
  if (s.status === 'needs-input') return 0;
  if (s.status === 'error') return 1;
  if (s.status === 'running') return 2;
  if (s.unread) return 3;
  return 4;
}

export function homeSessions(all: SessionSummary[], kind: SessionKind, limit: number): SessionSummary[] {
  return all
    .filter((s) => s.kind === kind && !s.archived)
    .sort((a, b) => attentionRank(a) - attentionRank(b) || b.updatedAt - a.updatedAt)
    .slice(0, limit);
}

export function filterActive(filter: SessionFilter): boolean {
  return filter.status !== 'all' || filter.project !== null || filter.date !== 'any';
}
