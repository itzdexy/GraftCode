import { describe, expect, it } from 'vitest';
import type { EffortLevel } from '../../../src/shared/schemas/common';
import type { ModelInfo } from '../../../src/shared/schemas/models';
import type { SessionSummary } from '../../../src/shared/schemas/sessions';
import type { SessionUsage } from '../../../src/shared/schemas/sessions';
import { baseName, partOfDay, relativeTime, shortenPath } from '../../../src/renderer/src/lib/format';
import { contextLimit, spendText, usageText } from '../../../src/renderer/src/features/composer/ContextUsage';
import { partBars } from '../../../src/renderer/src/features/composer/contextModel';
import { effortFor, moreModels, quickModels, resolveModel } from '../../../src/renderer/src/features/models/modelChoice';
import { fileGlyph } from '../../../src/renderer/src/features/session/fileCardModel';
import {
  DEFAULT_FILTER,
  groupByProject,
  homeSessions,
  matchesFilter,
  needsYou,
  visibleSessions,
  withoutThose
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

  it('lists what needs the user first, once, and not while a filter is on', () => {
    const all = [
      session({ id: 'ask', status: 'needs-input', updatedAt: NOW - 3000 }),
      session({ id: 'err', status: 'error', updatedAt: NOW - 1000 }),
      session({ id: 'run', status: 'running' }),
      session({ id: 'unread', unread: true }),
      session({ id: 'old', status: 'needs-input', archived: true }),
      session({ id: 'chat', kind: 'chat', status: 'needs-input' })
    ];
    const needing = needsYou(all, 'code', DEFAULT_FILTER);
    expect(needing.map((s) => s.id)).toEqual(['err', 'ask']);
    expect(needsYou(all, 'chat', DEFAULT_FILTER).map((s) => s.id)).toEqual(['chat']);
    expect(withoutThose(visibleSessions(all, 'code', DEFAULT_FILTER, NOW), needing).map((s) => s.id).sort()).toEqual(['run', 'unread']);
    expect(needsYou(all, 'code', { ...DEFAULT_FILTER, status: 'archived' })).toEqual([]);
    expect(needsYou(all, 'code', { ...DEFAULT_FILTER, status: 'running' })).toEqual([]);
    // Newest first whatever is pinned: the order says what has waited least, not what the user keeps at hand.
    const pinned = [session({ id: 'pinned', status: 'needs-input', pinned: true, updatedAt: NOW - 9000 }), session({ id: 'fresh', status: 'error', updatedAt: NOW - 10 })];
    expect(needsYou(pinned, 'code', DEFAULT_FILTER).map((s) => s.id)).toEqual(['fresh', 'pinned']);
    // The session that is open stays where it is: its question is on screen, and a row that
    // jumped to the top and back with every approval would be all movement and no news.
    expect(needsYou(all, 'code', DEFAULT_FILTER, 'ask').map((s) => s.id)).toEqual(['err']);
    expect(needsYou(all, 'code', DEFAULT_FILTER, 'run').map((s) => s.id)).toEqual(['err', 'ask']);
    expect(needsYou(all, 'code', DEFAULT_FILTER, null).map((s) => s.id)).toEqual(['err', 'ask']);
    // Nothing waits: the lists below are returned as they are.
    const calm = [session({ id: 'a' })];
    expect(withoutThose(calm, [])).toBe(calm);
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

  it('keeps the header of a project whose sessions all wait under Needs you, so another can be started there', () => {
    const waiting = [
      session({ id: 'w1', projectPath: 'C:/work/beta', projectName: 'beta', status: 'needs-input' }),
      session({ id: 'w2', projectPath: 'C:/work/beta', projectName: 'beta', status: 'error' }),
      session({ id: 'w3', projectPath: 'C:/work/Alpha', projectName: 'Alpha', status: 'needs-input' }),
      session({ id: 'w4', projectPath: null, projectName: null, status: 'error' })
    ];
    const groups = groupByProject([session({ id: '1', projectPath: 'C:/work/Alpha', projectName: 'Alpha' })], waiting);
    expect(groups.map((g) => [g.name, g.sessions.map((s) => s.id), g.elsewhere])).toEqual([
      ['Alpha', ['1'], 1],
      ['beta', [], 2]
    ]);
    // A session with no folder has no project to start another in: nothing is kept for it.
    expect(groupByProject([], [waiting[3]!])).toEqual([]);
    expect(groupByProject([session({ id: '1', projectPath: 'C:/work/Alpha', projectName: 'Alpha' })])[0]?.elsewhere).toBe(0);
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

  it('does not feature unavailable models but preserves an explicitly selected unavailable model for display', () => {
    const retired = { ...model('retired', { featured: true }), availability: { state: 'confirmed-retired' as const, source: 'provider' as const, checkedAt: NOW, reason: 'Shutdown announced.', selectable: false } };
    const list = [{ providerId: 'p1', models: [retired, model('replacement', { featured: true })] }];
    expect(quickModels(list, null).map((m) => m.ref.modelId)).toEqual(['replacement']);
    expect(quickModels(list, retired).map((m) => m.ref.modelId)).toEqual(['replacement', 'retired']);
    expect(moreModels(list, quickModels(list, null))[0]?.models).toEqual([retired]);
  });

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

  it('gives each kind of file its own icon', () => {
    const glyph = (name: string, mime: string) => fileGlyph({ name, mime });
    expect(glyph('r.pdf', 'application/pdf')).toBe('document');
    expect(glyph('r.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('document');
    expect(glyph('d.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('sheet');
    expect(glyph('d.csv', 'text/csv')).toBe('sheet');
    expect(glyph('s.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe('slides');
    expect(glyph('p.png', 'image/png')).toBe('image');
    expect(glyph('i.html', 'text/html')).toBe('web');
    expect(glyph('m.ts', 'text/plain')).toBe('code');
    expect(glyph('n.md', 'text/markdown')).toBe('text');
  });
});

describe('context and spend', () => {
  const usage = (totals: Partial<SessionUsage['totals']>, costUsd: number | null): SessionUsage => ({
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...totals },
    contextTokens: 0,
    contextLimit: 0,
    costUsd
  });

  it('describes the context window', () => {
    expect(usageText(50_000, 200_000)).toBe('50K of 200K tokens used (25%)');
    expect(usageText(10, 0)).toBe('Context size unknown');
  });

  it('measures a session against the model it will use next, not the limit recorded at its last turn', () => {
    // A session whose last turn recorded 32K (a size since corrected, or another model's) on a model with a 1M window.
    expect(contextLimit(32_768, { contextWindow: 1_048_576 })).toBe(1_048_576);
    // Until the model list has loaded, the recorded limit is all there is.
    expect(contextLimit(200_000, null)).toBe(200_000);
    expect(contextLimit(0, undefined)).toBe(0);
  });

  it('draws each part against the largest', () => {
    expect(partBars([{ id: 'results', label: 'Tool results', tokens: 22_100 }, { id: 'system', label: 'System prompt', tokens: 5_525 }])).toEqual([
      { id: 'results', label: 'Tool results', tokens: '22K', share: 1 },
      { id: 'system', label: 'System prompt', tokens: '5.5K', share: 0.25 }
    ]);
    expect(partBars([])).toEqual([]);
    // A part too small to round to a hundredth still shows a sliver, so no row looks empty.
    expect(partBars([{ id: 'results', label: 'Tool results', tokens: 100_000 }, { id: 'user', label: 'Your messages', tokens: 12 }])[1]).toMatchObject({ tokens: '12', share: 0.01 });
  });

  it('summarizes tokens, the share read from cache, and cost', () => {
    expect(spendText(usage({}, null))).toBeNull();
    expect(spendText(usage({ inputTokens: 2000, cacheReadTokens: 6000, outputTokens: 1500 }, 0.4213))).toEqual({
      tokens: '8.0K input (75% from cache) · 1.5K output',
      cost: 'About $0.42'
    });
    expect(spendText(usage({ inputTokens: 900, outputTokens: 20 }, 0.004))).toEqual({ tokens: '900 input · 20 output', cost: 'Less than $0.01' });
    expect(spendText(usage({ inputTokens: 900 }, null))?.cost).toBe('No published prices for this model');
  });
});
