import { describe, expect, it } from 'vitest';
import type { ContentBlock, StoredMessage } from '../../../src/shared/schemas/messages';
import { countChanges, parsePatch, rowsFromHunks, toSplitRows } from '../../../src/renderer/src/features/diff/diffModel';
import { commandSuggestions, detectToken } from '../../../src/renderer/src/features/composer/suggestions';
import { buildTranscript, summarizeCalls, type ToolCall } from '../../../src/renderer/src/features/session/transcriptModel';
import { evictViews, MAX_CACHED_VIEWS, viewOf } from '../../../src/renderer/src/stores/sessions';

let seq = 0;
function msg(role: 'user' | 'assistant', content: ContentBlock[], meta: StoredMessage['meta'] = {}): StoredMessage {
  seq++;
  return { id: `m${seq}`, sessionId: 's', seq, role, content, meta, createdAt: seq };
}

function call(name: string, input: unknown, result: Partial<NonNullable<ToolCall['result']>> | null = null): ToolCall {
  return {
    id: `${name}-${Math.random()}`,
    name,
    input,
    result: result ? { type: 'tool_result', toolUseId: 'x', content: [], isError: false, ...result } : null,
    running: null
  };
}

const NO_LIVE = { streaming: null, running: {} };

describe('transcript model', () => {
  it('folds consecutive tool calls across messages into one group with their results', () => {
    const items = buildTranscript(
      [
        msg('user', [{ type: 'text', text: 'fix it' }]),
        msg('assistant', [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } }]),
        msg('user', [{ type: 'tool_result', toolUseId: 't1', content: [{ type: 'text', text: '1 a' }], isError: false }]),
        msg('assistant', [{ type: 'tool_use', id: 't2', name: 'Shell', input: { command: 'npm test' } }]),
        msg('user', [{ type: 'tool_result', toolUseId: 't2', content: [], isError: true }]),
        msg('assistant', [{ type: 'text', text: 'Done.' }])
      ],
      NO_LIVE
    );
    expect(items.map((i) => i.kind)).toEqual(['user', 'text', 'tools', 'text']);
    const tools = items[2];
    expect(tools?.kind === 'tools' && tools.calls.map((c) => [c.name, c.result?.isError])).toEqual([
      ['Read', false],
      ['Shell', true]
    ]);
    const last = items[3];
    expect(last?.kind === 'text' && last.endOfTurn).toBe(true);
    const first = items[1];
    expect(first?.kind === 'text' && first.endOfTurn).toBe(false);
  });

  it('shows what was typed, hides reminders and keeps todos and plans as their own items', () => {
    const items = buildTranscript(
      [
        msg('user', [{ type: 'text', text: 'note to model' }, { type: 'text', text: 'hi @a.ts' }, { type: 'text', text: '<file path="a.ts">...' }], { typed: 'hi @a.ts' }),
        msg('user', [{ type: 'text', text: 'reminder' }], { kind: 'reminder' }),
        msg('assistant', [{ type: 'tool_use', id: 'todo', name: 'TodoWrite', input: { todos: [{ content: 'A', status: 'pending' }] } }]),
        msg('user', [{ type: 'tool_result', toolUseId: 'todo', content: [], isError: false, display: { kind: 'todos', todos: [{ id: '1', content: 'A', status: 'completed' }] } }]),
        msg('assistant', [{ type: 'tool_use', id: 'plan', name: 'ExitPlanMode', input: { plan: 'Do X' } }]),
        msg('user', [{ type: 'tool_result', toolUseId: 'plan', content: [], isError: false, display: { kind: 'plan', plan: 'Do X', approved: true, feedback: null } }])
      ],
      NO_LIVE
    );
    expect(items.map((i) => i.kind)).toEqual(['user', 'todos', 'plan']);
    const user = items[0];
    expect(user?.kind === 'user' && user.text).toBe('hi @a.ts');
    const todos = items[1];
    expect(todos?.kind === 'todos' && [todos.latest, todos.todos[0]?.status]).toEqual([true, 'completed']);
    const plan = items[2];
    expect(plan?.kind === 'plan' && plan.display?.approved).toBe(true);
  });

  it('appends live thinking and text, and marks running calls', () => {
    const items = buildTranscript(
      [msg('user', [{ type: 'text', text: 'go' }]), msg('assistant', [{ type: 'tool_use', id: 'run', name: 'Shell', input: { command: 'sleep 1' } }])],
      { streaming: { messageId: 'live', text: 'Partial', thinking: 'hmm' }, running: { run: { name: 'Shell', summary: 'Ran sleep 1', output: 'zz' } } }
    );
    expect(items.map((i) => i.kind)).toEqual(['user', 'tools', 'thinking', 'text']);
    const tools = items[1];
    expect(tools?.kind === 'tools' && tools.calls[0]?.running).toEqual({ summary: 'Ran sleep 1', output: 'zz' });
    const live = items[3];
    expect(live?.kind === 'text' && [live.live, live.endOfTurn]).toEqual([true, false]);
  });

  it('summarizes groups in plain language with failure counts', () => {
    expect(summarizeCalls([call('Read', { file_path: 'src/a.ts' }), call('Read', { file_path: 'src/b.ts' })])).toBe('Read 2 files');
    expect(
      summarizeCalls([
        call('Shell', { command: 'a' }, { display: { kind: 'shell', command: 'a', cwd: '.', exitCode: 0, output: '', truncated: false, logPath: null, durationMs: 1, timedOut: false, interrupted: false, backgroundId: null } }),
        call('Shell', { command: 'b' }, { display: { kind: 'shell', command: 'b', cwd: '.', exitCode: 1, output: '', truncated: false, logPath: null, durationMs: 1, timedOut: false, interrupted: false, backgroundId: null } }),
        call('Edit', { file_path: 'x.ts' })
      ])
    ).toBe('Edited x.ts, ran 2 commands (1 failed)');
    expect(summarizeCalls([call('Shell', { command: 'npm ci', description: 'install dependencies.' })])).toBe('Install dependencies');
    expect(summarizeCalls([call('mcp__docs__search', {})])).toBe('Used search from docs');
  });

  it('never reports a failed or declined edit as edited (regression: "Edited notes.txt" after an error)', () => {
    expect(summarizeCalls([call('Edit', { file_path: 'notes.txt' }, { isError: true })])).toBe("Couldn't edit notes.txt");
    expect(summarizeCalls([call('Grep', { pattern: 'needle' }), call('Edit', { file_path: 'notes.txt' }, { isError: true })])).toBe(
      "Couldn't edit notes.txt, searched for “needle”"
    );
    expect(summarizeCalls([call('Edit', { file_path: 'a.ts' }), call('Edit', { file_path: 'b.ts' }, { isError: true })])).toBe("Edited a.ts, couldn't edit b.ts");
    expect(summarizeCalls([call('Edit', { file_path: 'a.ts' }, { isError: true, display: { kind: 'denied', reason: 'no' } })])).toBe('One action was declined');
  });
});

describe('diff model', () => {
  const patch = ['Index: a.txt', '===', '--- a.txt', '+++ a.txt', '@@ -1,3 +1,3 @@', ' keep', '-old', '--- not a header', '+new', '\\ No newline at end of file'].join('\n');

  it('parses hunks, line numbers and lines that look like headers', () => {
    const rows = parsePatch(patch);
    expect(rows.map((r) => r.type)).toEqual(['hunk', 'ctx', 'del', 'del', 'add', 'note']);
    expect(rows[1]).toMatchObject({ oldNo: 1, newNo: 1, text: 'keep' });
    expect(rows[3]).toMatchObject({ text: '-- not a header', oldNo: 3 });
    expect(rows[4]).toMatchObject({ text: 'new', newNo: 2 });
    expect(countChanges(rows)).toEqual({ added: 1, removed: 2 });
  });

  it('pairs removed and added runs side by side', () => {
    const split = toSplitRows(parsePatch(patch));
    expect(split.map((r) => [r.left?.type ?? null, r.right?.type ?? null, r.full?.type ?? null])).toEqual([
      [null, null, 'hunk'],
      ['ctx', 'ctx', null],
      ['del', 'add', null],
      ['del', null, null],
      [null, null, 'note']
    ]);
  });

  it('numbers hunks from git-layer hunks', () => {
    const rows = rowsFromHunks([
      { header: '@@ -1 +1 @@', lines: ['-a', '+b'] },
      { header: '@@ -10 +10 @@', lines: ['-c', '+d'] }
    ]);
    expect(rows.filter((r) => r.type === 'hunk').map((r) => r.hunk)).toEqual([0, 1]);
    expect(rows.find((r) => r.text === 'd')).toMatchObject({ hunk: 1, newNo: 10 });
  });
});

describe('composer suggestions', () => {
  it('detects a command at the start and a mention after whitespace', () => {
    expect(detectToken('/he', 3)).toEqual({ kind: 'slash', query: 'he', start: 0, end: 3 });
    expect(detectToken('/help me', 8)).toBeNull();
    expect(detectToken('look at @src/a', 14)).toEqual({ kind: 'mention', query: 'src/a', start: 8, end: 14 });
    expect(detectToken('mail me@x.com', 13)).toBeNull();
    expect(detectToken('@srcrest', 4)).toEqual({ kind: 'mention', query: 'src', start: 0, end: 8 });
  });

  it('ranks prefix matches first and sends argument-free commands on Enter', () => {
    const items = commandSuggestions(
      [
        { name: 'help', description: 'Help', argumentHint: null, source: 'builtin', path: null },
        { name: 'compact', description: 'Compact', argumentHint: '[what to keep]', source: 'builtin', path: null },
        { name: 'chelp', description: 'Other', argumentHint: null, source: 'user', path: null }
      ],
      'he'
    );
    expect(items[0]).toMatchObject({ label: '/help', insert: '/help', sendOnEnter: true });
    expect(commandSuggestions([{ name: 'compact', description: '', argumentHint: '[x]', source: 'builtin', path: null }], 'co')[0]).toMatchObject({
      insert: '/compact ',
      sendOnEnter: false
    });
  });
});

describe('cached session views', () => {
  it('keeps the most recently opened transcripts and drops the oldest', () => {
    const empty = viewOf({ views: {} }, 'none');
    let views: Record<string, typeof empty> = {};
    let order: string[] = [];
    for (let i = 0; i < MAX_CACHED_VIEWS + 3; i++) {
      const id = `s${i}`;
      ({ views, order } = evictViews({ ...views, [id]: empty }, order, id));
    }
    expect(Object.keys(views)).toHaveLength(MAX_CACHED_VIEWS);
    expect(views.s0).toBeUndefined();
    expect(order.at(-1)).toBe(`s${MAX_CACHED_VIEWS + 2}`);
    // Reopening an old one moves it to the end instead of evicting it.
    ({ views, order } = evictViews(views, order, 's3'));
    expect(order.at(-1)).toBe('s3');
    expect(Object.keys(views)).toHaveLength(MAX_CACHED_VIEWS);
  });
});
