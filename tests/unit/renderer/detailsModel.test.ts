import { describe, expect, it } from 'vitest';
import type { McpServerView } from '../../../src/shared/schemas/customize';
import type { StoredMessage, ToolResultBlock } from '../../../src/shared/schemas/messages';
import type { BackgroundShellView } from '../../../src/shared/schemas/panels';
import {
  connectorRow,
  connectorsSummary,
  contextBreakdown,
  detailsShown,
  elapsedText,
  nearPath,
  percentText,
  sessionOutputs,
  taskRows,
  tasksSummary
} from '../../../src/renderer/src/features/session/details/detailsModel';
import { makeAgentRun } from './agentRun';

describe('when the details column is drawn', () => {
  it('needs to be wanted, no panel in its place, and room for the conversation', () => {
    expect(detailsShown(true, 0, 1600, 262)).toBe(true);
    expect(detailsShown(false, 0, 1600, 262)).toBe(false);
    expect(detailsShown(true, 1, 1600, 262)).toBe(false);
    // 1000 − 262 − 288 leaves 450 for the conversation; 960 leaves 410, under the 420 it keeps.
    expect(detailsShown(true, 0, 1000, 262)).toBe(true);
    expect(detailsShown(true, 0, 960, 262)).toBe(false);
    expect(detailsShown(true, 0, 960, 0)).toBe(true);
  });
});

describe('the context, part by part', () => {
  const report = {
    parts: [
      { id: 'system' as const, label: 'System prompt', tokens: 2000 },
      { id: 'user' as const, label: 'Your messages', tokens: 6000 },
      { id: 'tools' as const, label: 'Tools', tokens: 0 },
      { id: 'results' as const, label: 'Tool results', tokens: 12000 }
    ],
    measured: 40_000,
    limit: 200_000
  };

  it('scales the estimated parts to the count, largest first, and leaves out empty ones', () => {
    const b = contextBreakdown(report, 0, 200_000, true);
    expect(b.used).toBe(40_000);
    expect(b.share).toBeCloseTo(0.2, 5);
    expect(b.rows.map((r) => [r.id, r.tokens])).toEqual([
      ['results', 24_000],
      ['user', 12_000],
      ['system', 4_000]
    ]);
    expect(b.rows.reduce((sum, r) => sum + r.tokens, 0)).toBe(40_000);
    expect(b.free).toBe(160_000);
    expect(b.freeShare).toBeCloseTo(0.8, 5);
  });

  it('says how far automatic compaction is, and nothing when it is off or the window is unknown', () => {
    expect(contextBreakdown(report, 0, 200_000, true).untilCompact).toBe(120_000);
    expect(contextBreakdown({ ...report, measured: 170_000 }, 0, 200_000, true).untilCompact).toBe(0);
    expect(contextBreakdown(report, 0, 200_000, false).untilCompact).toBeNull();
    expect(contextBreakdown(report, 0, 0, true).untilCompact).toBeNull();
  });

  it('takes the session’s own count first, the number the ring shows, then the provider’s, then the estimate', () => {
    const b = contextBreakdown(report, 30_000, 200_000, true);
    expect(b.used).toBe(30_000);
    expect(b.rows.reduce((sum, r) => sum + r.tokens, 0)).toBe(30_000);
    expect(contextBreakdown(report, 0, 200_000, true).used).toBe(40_000);
    expect(contextBreakdown({ ...report, measured: null }, 0, 200_000, true).used).toBe(20_000);
    expect(contextBreakdown(null, 5_000, 200_000, true)).toMatchObject({ used: 5_000, rows: [] });
  });

  it('writes shares as people say them', () => {
    expect(percentText(0)).toBe('0%');
    expect(percentText(0.0004)).toBe('<0.1%');
    expect(percentText(0.004)).toBe('0.4%');
    expect(percentText(0.08)).toBe('8%');
    expect(percentText(0.885)).toBe('89%');
  });
});

describe('the connectors', () => {
  const server = (name: string, state: McpServerView['state'], tools = 0): McpServerView => ({
    name,
    scope: 'user',
    path: '',
    config: { type: 'stdio', command: 'x', args: [], env: [], cwd: null, enabled: true, inherit: 'no-secrets' } as unknown as McpServerView['config'],
    state,
    error: null,
    hint: null,
    tools: Array.from({ length: tools }, (_, i) => ({ name: `t${String(i)}`, registeredAs: `mcp__${name}__t${String(i)}`, description: '', readOnly: false })),
    prompts: [],
    resources: false
  });

  it('offers the one thing to do about a server that needs it', () => {
    expect(connectorRow(server('blender', 'connected', 14))).toMatchObject({ status: 'Connected · 14 tools', action: null });
    expect(connectorRow(server('roblox', 'failed')).action).toBe('reconnect');
    expect(connectorRow(server('github', 'needs-auth')).action).toBe('sign-in');
    expect(connectorRow(server('local', 'untrusted')).action).toBe('review');
    expect(connectorRow(server('off', 'disabled')).action).toBeNull();
  });

  it('sums up what needs a hand first', () => {
    expect(connectorsSummary([])).toBe('None');
    expect(connectorsSummary([connectorRow(server('a', 'connected', 1)), connectorRow(server('b', 'disabled'))])).toBe('1 of 2 connected');
    expect(connectorsSummary([connectorRow(server('a', 'failed')), connectorRow(server('b', 'connected', 2))])).toBe('1 needs you');
    expect(connectorsSummary([connectorRow(server('a', 'failed')), connectorRow(server('b', 'needs-auth'))])).toBe('2 need you');
  });
});

describe('the outputs of a session', () => {
  const result = (display: ToolResultBlock['display'], isError = false): ToolResultBlock => ({ type: 'tool_result', toolUseId: 'x', content: [], isError, display });
  const message = (...blocks: ToolResultBlock[]): StoredMessage => ({ id: 'm', sessionId: 's', seq: 1, role: 'user', content: blocks, meta: {}, createdAt: 1 });

  it('are the files its tools made, first made first, once each', () => {
    const messages = [
      message(
        result({ kind: 'edit', path: 'src/Main.client.luau', created: true, patch: '', added: 3, removed: 0 }),
        result({ kind: 'edit', path: 'README.md', created: false, patch: '', added: 1, removed: 1 })
      ),
      message(
        result({ kind: 'edit', path: 'docs/plan.md', created: true, patch: '', added: 9, removed: 0 }, true),
        result({ kind: 'media', engine: 'e', model: 'm', prompt: 'p', costUsd: null, files: [{ path: 'art/gun.png', kind: 'image', bytes: 10, thumb: null }] }),
        result({ kind: 'edit', path: 'src/Main.client.luau', created: true, patch: '', added: 1, removed: 0 })
      ),
      message(result({ kind: 'file', name: 'notes.md', size: 4, mime: 'text/markdown', preview: null }))
    ];
    expect(sessionOutputs(messages)).toEqual([
      { path: 'src/Main.client.luau', name: 'Main.client.luau', where: 'project' },
      { path: 'art/gun.png', name: 'gun.png', where: 'project' },
      { path: 'notes.md', name: 'notes.md', where: 'chat' }
    ]);
  });
});

describe('the background tasks', () => {
  const shell = (id: string, status: BackgroundShellView['status'], startedAt: number, exitCode: number | null = null): BackgroundShellView => ({
    id,
    sessionId: 's',
    command: `npm run ${id}`,
    status,
    exitCode,
    startedAt,
    endedAt: status === 'running' ? null : startedAt + 10,
    logPath: ''
  });

  it('put what is still going first, then the newest, commands and agents together', () => {
    const rows = taskRows(
      [shell('dev', 'running', 100), shell('test', 'exited', 300, 1), shell('lint', 'killed', 50)],
      [makeAgentRun('audit', [], { status: 'running', startedAt: 200, title: 'Audit the icons', model: { providerId: 'p', modelId: 'm', label: 'Opus 5.5' } }), makeAgentRun('fonts', [], { startedAt: 400 })]
    );
    expect(rows.map((r) => [r.title, r.state, r.note])).toEqual([
      ['Audit the icons', 'running', 'Opus 5.5'],
      ['npm run dev', 'running', null],
      ['fonts', 'done', null],
      ['npm run test', 'failed', 'exit 1'],
      ['npm run lint', 'stopped', null]
    ]);
    expect(tasksSummary(rows)).toBe('2 running');
    expect(tasksSummary(rows.slice(2))).toBe('3 finished');
  });

  it('say how long something ran', () => {
    expect(elapsedText(999)).toBe('0s');
    expect(elapsedText(45_000)).toBe('45s');
    expect(elapsedText(192_000)).toBe('3m 12s');
    expect(elapsedText(3_840_000)).toBe('1h 4m');
  });
});

describe('where a folder is', () => {
  it('is the folder it is in, never the folder again', () => {
    expect(nearPath('/tmp/graft-e2e-project-x')).toBe('/tmp');
    expect(nearPath('/home/me/demo')).toBe('/home/me');
    expect(nearPath('/srv')).toBe('/');
    expect(nearPath('C:\\demo')).toBe('C:\\');
    expect(nearPath('C:\\Users\\demo\\')).toBe('C:\\Users');
  });

  it('is the last two names of a long path', () => {
    expect(nearPath('/home/me/code/demo')).toBe('…/me/code');
    expect(nearPath('C:\\Users\\ddexy\\AppData\\Local\\Temp\\graft-e2e-project-x')).toBe('…\\Local\\Temp');
  });
});
