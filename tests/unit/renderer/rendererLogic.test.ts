import { describe, expect, it } from 'vitest';
import type { EffortLevel } from '../../../src/shared/schemas/common';
import type { ModelInfo } from '../../../src/shared/schemas/models';
import type { SessionSummary } from '../../../src/shared/schemas/sessions';
import { baseName, partOfDay, relativeTime, shortenPath } from '../../../src/renderer/src/lib/format';
import { effortFor, moreModels, quickModels, resolveModel } from '../../../src/renderer/src/features/models/modelChoice';
import {
  DEFAULT_FILTER,
  groupByProject,
  homeSessions,
  matchesFilter,
  visibleSessions
} from '../../../src/renderer/src/features/shell/sessionLists';

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function session(partial: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    kind: 'code',
    title: partial.id,
    status: 'idle',
    pinned: false,
    archived: false,
    unread: false,
    incognito: false,
    projectId: null,
    projectPath: null,
    projectName: null,
    cwd: null,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    model: null,
    effort: null,
    permissionMode: 'ask',
    lastError: null,
    usage: { totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, contextTokens: 0, contextLimit: 0, costUsd: null },
    createdAt: NOW - DAY,
    updatedAt: NOW - MIN,
    ...partial
  };
}

function model(id: string, options: { featured?: boolean; levels?: EffortLevel[]; provider?: string } = {}): ModelInfo {
  const levels = options.levels ?? [];
  return {
    ref: { providerId: options.provider ?? 'p1', modelId: id },
    label: id,
    description: '',
    family: id,
    contextWindow: 100_000,
    maxOutputTokens: 8000,
    supportsTools: true,
    supportsVision: false,
    supportsWebSearch: false,
    effort: levels.length > 0 ? { levels, recommended: levels[0]!, default: levels[0]! } : null,
    featured: options.featured ?? false,
    cheap: false,
    createdAt: null,
    pricing: null
  };
}

describe('session lists', () => {
  it('hides archived sessions unless the archived filter is chosen', () => {
    const a = session({ id: 'a' });
    const b = session({ id: 'b', archived: true });
    expect(visibleSessions([a, b], 'code', DEFAULT_FILTER, NOW).map((s) => s.id)).toEqual(['a']);
    expect(visibleSessions([a, b], 'code', { ...DEFAULT_FILTER, status: 'archived' }, NOW).map((s) => s.id)).toEqual(['b']);
  });

  it('filters by attention, project and date', () => {
    const needs = session({ id: 'needs', status: 'needs-input', projectPath: '/p/one' });
    const unread = session({ id: 'unread', unread: true, projectPath: '/p/two' });
    const old = session({ id: 'old', updatedAt: NOW - 10 * DAY, projectPath: '/p/one' });
    expect(matchesFilter(needs, { ...DEFAULT_FILTER, status: 'attention' }, NOW)).toBe(true);
    expect(matchesFilter(unread, { ...DEFAULT_FILTER, status: 'attention' }, NOW)).toBe(true);
    expect(matchesFilter(unread, { ...DEFAULT_FILTER, status: 'idle' }, NOW)).toBe(false);
    expect(matchesFilter(old, { ...DEFAULT_FILTER, status: 'attention' }, NOW)).toBe(false);
    expect(matchesFilter(old, { ...DEFAULT_FILTER, project: '/p/one' }, NOW)).toBe(true);
    expect(matchesFilter(unread, { ...DEFAULT_FILTER, project: '/p/one' }, NOW)).toBe(false);
    expect(matchesFilter(old, { ...DEFAULT_FILTER, date: 'week' }, NOW)).toBe(false);
    expect(matchesFilter(old, { ...DEFAULT_FILTER, date: 'month' }, NOW)).toBe(true);
  });

  it('puts pinned sessions first, then the most recent', () => {
    const list = visibleSessions(
      [session({ id: 'older', updatedAt: NOW - 5 * MIN }), session({ id: 'pinned', pinned: true, updatedAt: NOW - DAY }), session({ id: 'newer' })],
      'code',
      DEFAULT_FILTER,
      NOW
    );
    expect(list.map((s) => s.id)).toEqual(['pinned', 'newer', 'older']);
  });

  it('groups by folder alphabetically and disambiguates groups with the same folder name', () => {
    const groups = groupByProject([
      session({ id: '1', projectPath: 'C:\\work\\zeta', projectName: 'zeta' }),
      session({ id: '2', projectPath: 'C:\\a\\New folder', projectName: 'New folder' }),
      session({ id: '3', projectPath: 'C:\\b\\New folder', projectName: 'New folder' }),
      session({ id: '4', projectPath: 'C:\\work\\Alpha', projectName: 'Alpha' })
    ]);
    expect(groups.map((g) => g.name)).toEqual(['Alpha', 'New folder', 'New folder', 'zeta']);
    expect(groups[1]?.detail).toBe('C:\\a\\New folder');
    expect(groups[2]?.detail).toBe('C:\\b\\New folder');
    expect(groups[0]?.detail).toBeNull();
  });

  it('orders home sessions by attention, then recency', () => {
    const list = homeSessions(
      [
        session({ id: 'idle-new', updatedAt: NOW }),
        session({ id: 'error', status: 'error', updatedAt: NOW - DAY }),
        session({ id: 'needs', status: 'needs-input', updatedAt: NOW - 2 * DAY }),
        session({ id: 'chat', kind: 'chat', status: 'needs-input' }),
        session({ id: 'unread', unread: true, updatedAt: NOW - 3 * DAY })
      ],
      'code',
      10
    );
    expect(list.map((s) => s.id)).toEqual(['needs', 'error', 'unread', 'idle-new']);
  });
});

describe('model choice', () => {
  const groups = [
    { providerId: 'p1', models: [model('big', { featured: true, levels: ['low', 'medium', 'high', 'max', 'taproot'] }), model('old')] },
    { providerId: 'p2', models: [model('local', { featured: true, provider: 'p2' })] }
  ];

  it('resolves a stored ref, falling back to the first featured model when it is stale', () => {
    expect(resolveModel(groups, { providerId: 'p1', modelId: 'old' })?.ref.modelId).toBe('old');
    expect(resolveModel(groups, { providerId: 'gone', modelId: 'x' })?.ref.modelId).toBe('big');
    expect(resolveModel([], null)).toBeNull();
  });

  it('keeps the current model in the quick list and the rest under More models', () => {
    const current = groups[0]!.models[1]!;
    const quick = quickModels(groups, current);
    expect(quick.map((m) => m.ref.modelId)).toEqual(['big', 'local', 'old']);
    expect(moreModels(groups, quick)).toEqual([]);
    const quickWithoutOld = quickModels(groups, null);
    expect(moreModels(groups, quickWithoutOld).map((g) => g.models.map((m) => m.ref.modelId))).toEqual([['old']]);
  });

  it('maps effort to what the model supports', () => {
    const big = groups[0]!.models[0]!;
    expect(effortFor(big, 'high')).toBe('high');
    expect(effortFor(big, 'extra')).toBe('high');
    expect(effortFor(big, null)).toBe('low');
    expect(effortFor(groups[1]!.models[0]!, 'high')).toBeNull();
  });
});

describe('formatting', () => {
  it('formats compact relative times', () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe('now');
    expect(relativeTime(NOW - 6 * MIN, NOW)).toBe('6m ago');
    expect(relativeTime(NOW - 2 * DAY, NOW)).toBe('2d ago');
    expect(relativeTime(NOW - 28 * DAY, NOW)).toBe('4w ago');
    expect(relativeTime(NOW + 5 * MIN, NOW)).toBe('now');
  });

  it('names the part of the day', () => {
    expect(partOfDay(new Date(2026, 8, 30, 8))).toBe('morning');
    expect(partOfDay(new Date(2026, 8, 30, 13))).toBe('afternoon');
    expect(partOfDay(new Date(2026, 8, 30, 22))).toBe('evening');
    expect(partOfDay(new Date(2026, 8, 30, 2))).toBe('evening');
  });

  it('shortens paths and takes folder names on both separators', () => {
    expect(baseName('C:\\Users\\me\\proj\\')).toBe('proj');
    expect(baseName('/home/me/proj')).toBe('proj');
    expect(shortenPath('C:\\Users\\someone\\very\\deeply\\nested\\project\\folder', 24)).toMatch(/^.{11}….{11}$/);
  });
});
