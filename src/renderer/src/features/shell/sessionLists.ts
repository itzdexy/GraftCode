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
  /** How many of the project's sessions are listed under Needs you instead of here. */
  elsewhere: number;
}

function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * Groups code sessions by project folder, alphabetically by folder name. `elsewhere` are the
 * sessions listed under Needs you: a project whose sessions all wait there keeps its header,
 * and with it the way to start another session in that folder.
 */
export function groupByProject(sessions: SessionSummary[], elsewhere: SessionSummary[] = []): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  const groupOf = (s: SessionSummary): ProjectGroup => {
    const key = s.projectPath ?? '';
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        path: s.projectPath,
        name: s.projectName ?? (s.projectPath ? folderName(s.projectPath) : 'No folder'),
        detail: null,
        sessions: [],
        elsewhere: 0
      };
      groups.set(key, group);
    }
    return group;
  };
  for (const s of sessions) groupOf(s).sessions.push(s);
  for (const s of elsewhere) if (s.projectPath) groupOf(s).elsewhere++;
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

/**
 * Sessions that wait for the user: for an answer or an approval, or stopped
 * with an error. Not archived, newest first. Empty while a filter is on, so
 * a filtered list shows only what was asked for. The session that is open
 * (`openId`) is left where it is: what it asks is on screen already, and a
 * row that moved up and back with every approval would only be noise.
 */
export function needsYou(all: SessionSummary[], kind: SessionKind, filter: SessionFilter, openId: string | null = null): SessionSummary[] {
  if (filterActive(filter)) return [];
  return all
    .filter((s) => s.kind === kind && !s.archived && s.id !== openId && (s.status === 'needs-input' || s.status === 'error'))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** `sessions` without the ones listed under Needs you, so nothing is shown twice. */
export function withoutThose(sessions: SessionSummary[], listed: SessionSummary[]): SessionSummary[] {
  if (listed.length === 0) return sessions;
  const ids = new Set(listed.map((s) => s.id));
  return sessions.filter((s) => !ids.has(s.id));
}
