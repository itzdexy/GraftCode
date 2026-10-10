import { describe, expect, it } from 'vitest';
import type { ContentBlock, StoredMessage } from '../../../src/shared/schemas/messages';
import { changedSpans, countChanges, coveredRows, hunkTexts, inlineSpans, parsePatch, pieces, rowsFromHunks, toSplitRows } from '../../../src/renderer/src/features/diff/diffModel';
import { commandSuggestions, detectToken } from '../../../src/renderer/src/features/composer/suggestions';
import {
  activityTitle,
  buildTranscript,
  callParts,
  describeCall,
  diffTotals,
  groupActivity,
  liveLabel,
  madeFiles,
  summarizeCalls,
  type ActivityItem,
  type ToolCall
} from '../../../src/renderer/src/features/session/transcriptModel';
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

/** What a command that ran leaves behind. */
const ran = (command: string) => ({ kind: 'shell' as const, command, cwd: '/', exitCode: 0, output: '', truncated: false, logPath: null, durationMs: 1, timedOut: false, interrupted: false, backgroundId: null });

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

  it('gives a streamed reply the same key once it is stored, so it stays in place instead of arriving again', () => {
    const user = msg('user', [{ type: 'text', text: 'go' }]);
    const live = buildTranscript([user], { streaming: { messageId: 'reply', text: 'Almost', thinking: 'hmm' }, running: {} });
    const stored: StoredMessage = { ...msg('assistant', [{ type: 'thinking', text: 'hmm' }, { type: 'text', text: 'Almost done.' }]), id: 'reply' };
    const done = buildTranscript([user, stored], NO_LIVE);
    const keyOf = (items: ReturnType<typeof buildTranscript>, kind: 'text' | 'thinking'): string | undefined => items.find((i) => i.kind === kind)?.key;
    expect(keyOf(done, 'text')).toBe(keyOf(live, 'text'));
    expect(keyOf(done, 'thinking')).toBe(keyOf(live, 'thinking'));
  });

  it('keeps every item key distinct when a message has several text blocks', () => {
    const items = buildTranscript(
      [
        msg('user', [{ type: 'text', text: 'go' }]),
        msg('assistant', [{ type: 'text', text: 'First.' }, { type: 'tool_use', id: 'k1', name: 'Read', input: { file_path: 'a.ts' } }, { type: 'text', text: 'Second.' }])
      ],
      NO_LIVE
    );
    const keys = items.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('summarizes groups in plain language with failure counts', () => {
    expect(summarizeCalls([call('Read', { file_path: 'src/a.ts' }), call('Read', { file_path: 'src/b.ts' })])).toBe('Read 2 files');
    expect(
      summarizeCalls([
        call('Shell', { command: 'a' }, { display: { kind: 'shell', command: 'a', cwd: '.', exitCode: 0, output: '', truncated: false, logPath: null, durationMs: 1, timedOut: false, interrupted: false, backgroundId: null } }),
        call('Shell', { command: 'b' }, { display: { kind: 'shell', command: 'b', cwd: '.', exitCode: 1, output: '', truncated: false, logPath: null, durationMs: 1, timedOut: false, interrupted: false, backgroundId: null } }),
        call('Edit', { file_path: 'x.ts' })
      ])
    ).toBe('Ran 2 commands (1 failed), edited x.ts');
    // A command's description is told as things stand: as written until it runs, under way while it does, done once it has.
    const install = { command: 'npm ci', description: 'install dependencies.' };
    expect(summarizeCalls([call('Shell', install)])).toBe('Install dependencies');
    expect(summarizeCalls([{ ...call('Shell', install), running: { summary: '', output: '' } }])).toBe('Installing dependencies');
    expect(summarizeCalls([call('Shell', install, { display: ran('npm ci') })])).toBe('Installed dependencies');
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

describe('turn activity', () => {
  const edit = (id: string, path: string, added: number, removed: number, created = false): ContentBlock => ({
    type: 'tool_result',
    toolUseId: id,
    content: [],
    isError: false,
    display: { kind: 'edit', path, created, patch: '', added, removed }
  });

  function turn(): StoredMessage[] {
    seq = 0;
    return [
      { ...msg('user', [{ type: 'text', text: 'fix it' }]), createdAt: 1_000 },
      { ...msg('assistant', [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'w', name: 'Write', input: { file_path: 'src/new.ts' } }]), createdAt: 2_000 },
      { ...msg('user', [edit('w', 'src/new.ts', 10, 0, true)]), createdAt: 3_000 },
      { ...msg('assistant', [{ type: 'tool_use', id: 'e', name: 'Edit', input: { file_path: 'src/old.ts' } }]), createdAt: 4_000 },
      { ...msg('user', [edit('e', 'src/old.ts', 3, 2)]), createdAt: 5_000 },
      { ...msg('assistant', [{ type: 'text', text: 'Done.' }]), createdAt: 63_000 }
    ];
  }

  it('folds the work before the answer into one block with totals and duration, then lists the files it changed', () => {
    const items = groupActivity(buildTranscript(turn(), NO_LIVE), false);
    expect(items.map((i) => i.kind)).toEqual(['user', 'activity', 'text', 'edits']);
    const edits = items[3];
    expect(edits?.kind === 'edits' && edits.files.map((f) => [f.path, f.added, f.removed, f.created])).toEqual([
      ['src/new.ts', 10, 0, true],
      ['src/old.ts', 3, 2, false]
    ]);
    // The card knows the message that started its turn: that message's snapshot is what Undo goes back to.
    const asked = items[0];
    expect(edits?.kind === 'edits' && edits.messageId).toBe(asked?.kind === 'user' ? asked.message.id : 'none');
    const block = items[1] as ActivityItem;
    expect(block.live).toBe(false);
    expect(block.steps.map((s) => s.kind)).toEqual(['text', 'tool', 'tool']);
    expect(block.endedAt - (block.startedAt ?? 0)).toBe(62_000);
    expect(activityTitle(block)).toBe('Created new.ts, edited old.ts');
    const calls = block.steps.flatMap((s) => (s.kind === 'tool' ? [s.call] : []));
    expect(diffTotals(calls)).toEqual({ added: 13, removed: 2 });
  });

  it('stops a long summary after three kinds of work, counting the rest as actions', () => {
    const shell = (command: string): ToolCall => call('Shell', { command });
    const calls = [shell('a'), shell('b'), call('Read', { file_path: 'x.ts' }), call('Grep', { pattern: 'p' }), call('Glob', { pattern: '*' }), call('Glob', { pattern: '**' })];
    expect(summarizeCalls(calls, 3)).toBe('Ran 2 commands, read x.ts, searched for “p”, and 2 more actions');
    expect(summarizeCalls(calls)).toBe('Ran 2 commands, read x.ts, searched for “p”, listed files 2 times');
  });

  it('shows each later turn of a mission as a marker, never as something the user wrote', () => {
    const messages: StoredMessage[] = [
      msg('user', [{ type: 'text', text: 'Add rate limiting\n\n---\n\nThis is a mission…' }], { typed: 'Add rate limiting' }),
      msg('assistant', [{ type: 'text', text: 'Looked around.' }]),
      msg('user', [{ type: 'text', text: '[Mission, turn 2 of 10] Keep working on the mission.…' }], { kind: 'mission', mission: { turn: 2, of: 10, afterChecks: false } }),
      msg('assistant', [{ type: 'text', text: 'Done.' }]),
      msg('user', [{ type: 'text', text: '[Mission, turn 3 of 10] You reported the mission done, but…' }], { kind: 'mission', mission: { turn: 3, of: 10, afterChecks: true } })
    ];
    const items = buildTranscript(messages, NO_LIVE);
    expect(items.map((i) => i.kind)).toEqual(['user', 'text', 'mission', 'text', 'mission']);
    expect(items[0]).toMatchObject({ kind: 'user', text: 'Add rate limiting' });
    expect(items[2]).toMatchObject({ kind: 'mission', turn: 2, of: 10, afterChecks: false });
    expect(items[4]).toMatchObject({ kind: 'mission', turn: 3, of: 10, afterChecks: true });
  });

  it('words what the agent records in a mission', () => {
    const note = call('MissionUpdate', { note: { kind: 'decision', text: 'Use a token bucket.' } }, { display: { kind: 'mission', action: 'note', noteKind: 'decision', text: 'Use a token bucket.' } });
    expect(callParts(note)).toMatchObject({ verb: 'Noted a decision', target: 'Use a token bucket.' });
    expect(callParts(call('MissionUpdate', { status: 'done', summary: 'All in.' })).verb).toBe('Reported the mission done');
    expect(callParts(call('MissionUpdate', { status: 'blocked', summary: 'Need a key.' }))).toMatchObject({ verb: 'Paused the mission', target: 'Need a key.' });
    expect(summarizeCalls([note, note, call('Read', { file_path: 'x.ts' })])).toBe('Read x.ts, noted 2 things for the mission');
  });

  it('words a look at the code’s structure by what was asked', () => {
    expect(callParts(call('Symbols', { action: 'outline', path: 'src/main/agent/mission.ts' }))).toMatchObject({ verb: 'Outlining', target: 'mission.ts' });
    const found = { display: { kind: 'grep' as const, pattern: 'uses of allow', count: 3, preview: '' } };
    expect(callParts(call('Symbols', { action: 'references', name: 'allow' }, found))).toMatchObject({ verb: 'Found uses of', target: 'allow', mono: true });
    expect(callParts(call('Symbols', { action: 'definition', name: 'allow' }, found))).toMatchObject({ verb: 'Found the definition of', target: 'allow' });
    expect(callParts(call('Symbols', { action: 'importers', path: 'src/a.ts' }, found))).toMatchObject({ verb: 'Found what imports', target: 'a.ts' });
    expect(callParts(call('Symbols', { action: 'tests', path: 'src/a.ts' }, found))).toMatchObject({ verb: 'Found the tests of', target: 'a.ts' });
    expect(summarizeCalls([call('Symbols', { action: 'tests', path: 'src/a.ts' }, found), call('Symbols', { action: 'outline', path: 'src/a.ts' }, found)])).toBe('Looked up the code’s structure 2 times');

    // What the language server is asked reads as a row too, not as the tool's name.
    const semantic = (input: Record<string, unknown>, result?: typeof found) => callParts(call('SemanticCode', input, result));
    expect(semantic({ action: 'symbol', file: 'src/a.ts', name: 'allow' })).toMatchObject({ verb: 'Finding the symbol', target: 'allow', mono: true });
    expect(semantic({ action: 'symbol', file: 'src/a.ts', name: 'allow' }, found)).toMatchObject({ verb: 'Found the symbol', target: 'allow' });
    expect(semantic({ action: 'outline', file: 'src/limits.ts' }, found)).toMatchObject({ verb: 'Outlined', target: 'limits.ts' });
    expect(semantic({ action: 'diagnostics', file: 'src/limits.ts' }, found)).toMatchObject({ verb: 'Checked the types of', target: 'limits.ts' });
    expect(semantic({ action: 'references', file: 'src/limits.ts', line: 12, column: 17 }, found)).toMatchObject({ verb: 'Looked up the uses at', target: 'limits.ts:12', title: 'src/limits.ts' });
    expect(semantic({ action: 'definition', file: 'src/limits.ts', line: 3, column: 1 })).toMatchObject({ verb: 'Looking up the definition at', target: 'limits.ts:3' });
    expect(semantic({ action: 'implementation', file: 'a.ts', line: 1, column: 1 }, found).verb).toBe('Looked up the implementations at');
    expect(semantic({ action: 'typeDefinition', file: 'a.ts', line: 1, column: 1 }, found).verb).toBe('Looked up the type’s declaration at');
    expect(semantic({ action: 'hover', file: 'a.ts', line: 1, column: 1 }, found).verb).toBe('Looked up the type at');
    expect(describeCall(call('SemanticCode', { action: 'symbol', file: 'src/a.ts', name: 'allow' }, found))).toBe('Asked the language server about allow');
    expect(describeCall(call('SemanticCode', { action: 'outline', file: 'src/a.ts' }))).toBe('Asking the language server about src/a.ts');
    expect(summarizeCalls([call('SemanticCode', { action: 'symbol', file: 'a.ts', name: 'allow' }, found), call('Symbols', { action: 'outline', path: 'src/a.ts' }, found)])).toBe('Looked up the code’s structure 2 times');
  });

  it('words a search for tools, and what an agent reads from an MCP server’s resources', () => {
    expect(callParts(call('ToolSearch', { query: 'create issue' }))).toMatchObject({ verb: 'Searching tools for', target: '“create issue”' });
    expect(callParts(call('ToolSearch', { query: 'create issue' }, { display: { kind: 'text', text: 'Loaded 1 tool' } }))).toMatchObject({ verb: 'Searched tools for' });
    expect(callParts(call('mcp__resources__list', { server: 'docs' }))).toMatchObject({ verb: 'Listing MCP resources', target: 'docs' });
    expect(callParts(call('mcp__resources__read', { server: 'docs', uri: 'notes://readme' }))).toMatchObject({ verb: 'Reading', target: 'notes://readme', mono: true });
    expect(describeCall(call('mcp__resources__read', { server: 'docs', uri: 'notes://readme' }))).toBe('Reading notes://readme from docs');
    expect(summarizeCalls([call('ToolSearch', { query: 'issue' }), call('mcp__resources__read', { server: 'docs', uri: 'a' }), call('mcp__resources__read', { server: 'docs', uri: 'b' })])).toBe(
      'Looked for a tool, looked at 2 MCP resources'
    );
  });

  it('words a group of agents by how many ran and what for', () => {
    const agents = [
      { id: 'a', role: 'explorer', task: 'Map the routes', prompt: 'Look.' },
      { id: 'b', role: 'implementer', task: 'Add the endpoint', prompt: 'Build.', depends_on: ['a'] }
    ];
    const running = call('RunAgents', { goal: 'Add rate limiting', agents });
    expect(callParts(running)).toMatchObject({ verb: 'Running 2 agents', target: 'Add rate limiting' });
    expect(describeCall(running)).toBe('Running 2 agents: Add rate limiting');
    const done = call('RunAgents', { goal: 'Add rate limiting', agents }, { display: { kind: 'agents', goal: 'Add rate limiting', agents: [] } });
    expect(callParts(done)).toMatchObject({ verb: 'Ran 2 agents', target: 'Add rate limiting' });
    expect(callParts(call('RunAgents', { goal: 'Look around', agents: agents.slice(0, 1) })).verb).toBe('Running an agent');
    expect(summarizeCalls([done, call('Read', { file_path: 'x.ts' })])).toBe('Ran 2 agents, read x.ts');
    expect(summarizeCalls([done, done])).toBe('Ran 2 groups of agents');
  });

  it('words each step as what was done, then what it was done to', () => {
    expect(callParts(call('Edit', { file_path: 'src/main/agent/session.ts' }, { display: { kind: 'edit', path: 'src/main/agent/session.ts', created: false, patch: '', added: 3, removed: 1 } }))).toEqual({
      verb: 'Edited',
      target: 'session.ts',
      mono: false,
      title: 'src/main/agent/session.ts'
    });
    const tests = { command: 'npm test', description: 'Run the unit tests.' };
    // Waiting to be allowed, nothing runs: the description stays as the model wrote it.
    expect(callParts(call('Shell', tests))).toMatchObject({ verb: 'Run the unit tests', target: '' });
    expect(callParts({ ...call('Shell', tests), running: { summary: '', output: '' } })).toMatchObject({ verb: 'Running the unit tests', target: '' });
    expect(callParts(call('Shell', tests, { display: ran('npm test') }))).toMatchObject({ verb: 'Ran the unit tests', target: '' });
    // Declined, it never ran: "Ran the unit tests" beside "Declined" would be untrue.
    expect(callParts(call('Shell', tests, { display: { kind: 'denied', reason: 'You declined it.' } })).verb).toBe('Run the unit tests');
    expect(describeCall(call('Shell', tests, { display: { kind: 'denied', reason: 'You declined it.' } }))).toBe('Run the unit tests');
    expect(describeCall(call('Shell', { command: 'npm test', description: 'Final check.' }, { display: ran('npm test') }))).toBe('Final check');
    // A key in a command is covered wherever the command is shown as a line.
    const withKey = call('Shell', { command: 'curl -H "Authorization: Bearer abcDEF0123456789abcDEF0123456789" https://api.example.com' });
    expect(callParts(withKey).target).toBe('curl -H "Authorization: Bearer ••••••••" https://api.example.com');
    expect(describeCall(withKey)).not.toContain('0123456789');
    // So is one in the address of a page that was read or opened.
    const fetched = call('WebFetch', { url: 'https://api.example.com/v1/data?api_key=abcd1234efgh5678ijkl' });
    expect(callParts(fetched).title).toBe('https://api.example.com/v1/data?api_key=••••••••');
    expect(describeCall(fetched)).toBe('Reading https://api.example.com/v1/data?api_key=••••••••');
    expect(callParts(call('Shell', { command: ['git status', 'git diff'].join('\n') }))).toMatchObject({ verb: '', target: 'git status', mono: true });
    expect(callParts(call('WebFetch', { url: 'https://www.anthropic.com/claude-opus-5-5' }))).toMatchObject({ verb: 'Reading', target: 'anthropic.com/claude-opus-5-5' });
  });

  it('keeps a running turn open, with streaming text outside the block', () => {
    const messages = turn().slice(0, 5);
    const items = groupActivity(buildTranscript(messages, { streaming: { messageId: 'live', text: 'Writing the ans', thinking: '' }, running: {} }), true);
    expect(items.map((i) => i.kind)).toEqual(['user', 'activity', 'text']);
    expect((items[1] as ActivityItem).live).toBe(true);
    // Without streaming text, the narration so far is work, not the answer.
    const working = groupActivity(buildTranscript(messages, NO_LIVE), true);
    expect(working.map((i) => i.kind)).toEqual(['user', 'activity']);
    expect((working[1] as ActivityItem).steps[0]?.kind).toBe('text');
  });

  it('keeps a finished reply as the answer while the turn wraps up, instead of folding it into the work', () => {
    // The reply is stored, but the turn is still open (hooks, the project's checks).
    const items = groupActivity(buildTranscript(turn(), NO_LIVE), true);
    expect(items.map((i) => i.kind)).toEqual(['user', 'activity', 'text']);
    const answer = items[2];
    expect(answer?.kind === 'text' && answer.text).toBe('Done.');
    expect((items[1] as ActivityItem).steps.map((s) => s.kind)).toEqual(['text', 'tool', 'tool']);
  });

  it('turns a reply back into narration when the turn goes on working after it', () => {
    const messages = [
      ...turn(),
      { ...msg('user', [{ type: 'text', text: 'The checks failed; fix them.' }], { kind: 'reminder' }), createdAt: 64_000 },
      { ...msg('assistant', [{ type: 'tool_use', id: 'fix', name: 'Edit', input: { file_path: 'src/old.ts' } }]), createdAt: 65_000 }
    ];
    const items = groupActivity(buildTranscript(messages, NO_LIVE), true);
    expect(items.map((i) => i.kind)).toEqual(['user', 'activity']);
    expect((items[1] as ActivityItem).steps.map((s) => s.kind)).toEqual(['text', 'tool', 'tool', 'text', 'tool']);
  });

  it('pairs a provider search with its results and counts the sites', () => {
    seq = 0;
    const items = groupActivity(
      buildTranscript(
        [
          msg('user', [{ type: 'text', text: 'history of rivals' }]),
          msg('assistant', [
            { type: 'provider', provider: 'anthropic', raw: {}, summary: 'Searched the web for “rivals”', search: { query: 'rivals', results: [] } },
            { type: 'provider', provider: 'anthropic', raw: {}, summary: '2 web results', search: { query: '', results: [{ title: 'A', url: 'https://a.dev' }, { title: 'B', url: 'https://b.dev' }] } },
            { type: 'text', text: 'Here is the history.' }
          ])
        ],
        NO_LIVE
      ),
      false
    );
    expect(items.map((i) => i.kind)).toEqual(['user', 'activity', 'text']);
    const block = items[1] as ActivityItem;
    expect(block.steps).toEqual([{ kind: 'search', key: expect.any(String) as unknown, search: { query: 'rivals', results: [{ title: 'A', url: 'https://a.dev' }, { title: 'B', url: 'https://b.dev' }] } }]);
    expect(activityTitle(block)).toBe('Searched 2 websites');

    const web = (query: string, urls: string[]): ToolCall =>
      call('WebSearch', { query }, { display: { kind: 'web-search', query, results: urls.map((url) => ({ title: url, url })) } });
    expect(summarizeCalls([web('a', ['https://x.dev', 'https://y.dev']), web('b', ['https://y.dev', 'https://z.dev'])])).toBe('Searched 3 websites');
    expect(summarizeCalls([call('WebSearch', { query: 'nothing' })])).toBe('Searched for “nothing”');
  });

  it('says how long a turn thought when thinking was all it did, and lets todos split the work', () => {
    seq = 0;
    const thought = groupActivity(
      buildTranscript(
        [
          { ...msg('user', [{ type: 'text', text: 'why?' }]), createdAt: 0 },
          { ...msg('assistant', [{ type: 'thinking', text: 'hmm' }, { type: 'text', text: 'Because.' }]), createdAt: 7_000 }
        ],
        NO_LIVE
      ),
      false
    );
    expect(activityTitle(thought[1] as ActivityItem)).toBe('Thought for 7s');

    seq = 0;
    const split = groupActivity(
      buildTranscript(
        [
          msg('user', [{ type: 'text', text: 'plan' }]),
          msg('assistant', [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: 'a.ts' } }]),
          msg('assistant', [{ type: 'tool_use', id: 't', name: 'TodoWrite', input: { todos: [] } }]),
          msg('assistant', [{ type: 'tool_use', id: 's', name: 'Shell', input: { command: 'ls' } }]),
          msg('assistant', [{ type: 'text', text: 'ok' }])
        ],
        NO_LIVE
      ),
      false
    );
    expect(split.map((i) => i.kind)).toEqual(['user', 'activity', 'todos', 'activity', 'text']);
  });

  it('keeps what the agent says in view and folds only the tool steps between, in the Normal view', () => {
    const items = groupActivity(buildTranscript(turn(), NO_LIVE), false, 'normal');
    expect(items.map((i) => i.kind)).toEqual(['user', 'text', 'activity', 'text', 'edits']);
    expect(items[1]).toMatchObject({ kind: 'text', text: 'Looking.' });
    const block = items[2] as ActivityItem;
    expect(block.live).toBe(false);
    expect(block.steps.map((s) => s.kind)).toEqual(['tool', 'tool']);
    expect(activityTitle(block)).toBe('Created new.ts, edited old.ts');
    expect(diffTotals(block.steps.flatMap((s) => (s.kind === 'tool' ? [s.call] : [])))).toEqual({ added: 13, removed: 2 });
  });

  it('starts a new block of steps after each thing the agent says', () => {
    seq = 0;
    const items = groupActivity(
      buildTranscript(
        [
          msg('user', [{ type: 'text', text: 'find it' }]),
          msg('assistant', [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: 'a.ts' } }]),
          msg('assistant', [{ type: 'tool_use', id: 'g', name: 'Grep', input: { pattern: 'x' } }]),
          msg('assistant', [{ type: 'text', text: 'Found it.' }, { type: 'tool_use', id: 's', name: 'Shell', input: { command: 'ls' } }]),
          msg('assistant', [{ type: 'text', text: 'ok' }])
        ],
        NO_LIVE
      ),
      false,
      'normal'
    );
    expect(items.map((i) => i.kind)).toEqual(['user', 'activity', 'text', 'activity', 'text']);
    expect((items[1] as ActivityItem).steps).toHaveLength(2);
    expect((items[3] as ActivityItem).steps).toHaveLength(1);
    // Every block keeps a key of its own, so one opening never opens another.
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });

  it('marks the newest steps as live only until the agent speaks again', () => {
    const messages = turn().slice(0, 5);
    const working = groupActivity(buildTranscript(messages, NO_LIVE), true, 'normal');
    expect(working.map((i) => i.kind)).toEqual(['user', 'text', 'activity']);
    expect((working[2] as ActivityItem).live).toBe(true);
    const speaking = groupActivity(buildTranscript(messages, { streaming: { messageId: 'live', text: 'Writing the ans', thinking: '' }, running: {} }), true, 'normal');
    expect(speaking.map((i) => i.kind)).toEqual(['user', 'text', 'activity', 'text']);
    expect((speaking[2] as ActivityItem).live).toBe(false);
    // A finished turn has no live block, whatever it ends with.
    expect((groupActivity(buildTranscript(messages, NO_LIVE), false, 'normal')[2] as ActivityItem).live).toBe(false);
  });

  it('leaves thoughts out of the Normal view and shows them in the Thinking and Verbose views', () => {
    seq = 0;
    const messages = [
      msg('user', [{ type: 'text', text: 'why?' }]),
      msg('assistant', [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: 'a.ts' } }]),
      msg('assistant', [{ type: 'thinking', text: 'hmm' }, { type: 'tool_use', id: 'g', name: 'Grep', input: { pattern: 'x' } }]),
      msg('assistant', [{ type: 'text', text: 'Because.' }])
    ];
    const normal = groupActivity(buildTranscript(messages, NO_LIVE), false, 'normal');
    // A thought that is not shown does not split the steps around it.
    expect(normal.map((i) => i.kind)).toEqual(['user', 'activity', 'text']);
    expect((normal[1] as ActivityItem).steps).toHaveLength(2);
    for (const view of ['thinking', 'verbose'] as const) {
      expect(groupActivity(buildTranscript(messages, NO_LIVE), false, view).map((i) => i.kind)).toEqual(['user', 'activity', 'thinking', 'activity', 'text']);
    }
    // The model narrating its progress is said, not thought: every view shows it.
    const narrated = [msg('user', [{ type: 'text', text: 'go' }]), msg('assistant', [{ type: 'thinking', text: 'Checking the tests.', display: 'update' }, { type: 'text', text: 'Done.' }])];
    expect(groupActivity(buildTranscript(narrated, NO_LIVE), false, 'normal').map((i) => i.kind)).toEqual(['user', 'thinking', 'text']);
  });

  it('names what a live block is doing: the running step, else the newest one', () => {
    const messages = turn().slice(0, 4);
    const idle = groupActivity(buildTranscript(messages, NO_LIVE), true, 'normal').at(-1) as ActivityItem;
    expect(liveLabel(idle)).toBe('Edit src/old.ts');
    const running = groupActivity(buildTranscript(messages, { streaming: null, running: { e: { name: 'Edit', summary: 'Editing old.ts', output: '' } } }), true, 'normal').at(-1) as ActivityItem;
    expect(liveLabel(running)).toBe('Editing old.ts');
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

  it('marks the words that changed inside a line', () => {
    const shown = (line: string, spans: Array<{ start: number; end: number }>): string[] => spans.map((s) => line.slice(s.start, s.end));
    const renamed = changedSpans('return foo(bar);', 'return foo(baz);');
    expect(renamed && [shown('return foo(bar);', renamed.before), shown('return foo(baz);', renamed.after)]).toEqual([['bar'], ['baz']]);

    const before = "import { addUsage, type EffortLevel } from '@shared/schemas/common';";
    const after = "import { addUsage, EMPTY_USAGE, type EffortLevel } from '@shared/schemas/common';";
    const grown = changedSpans(before, after);
    expect(grown?.before).toEqual([]);
    expect(shown(after, grown?.after ?? []).join('')).toContain('EMPTY_USAGE');
    // Only what was added is marked, not the rest of the line.
    expect(shown(after, grown?.after ?? []).join('').length).toBeLessThan(16);

    // Words that changed next to each other read as one mark, across the space between them.
    const two = changedSpans('const total = first + second;', 'const total = alpha + beta;');
    expect(two?.after.map((s) => 'const total = alpha + beta;'.slice(s.start, s.end))).toEqual(['alpha', 'beta']);
    const run = changedSpans('say hello world now', 'say goodbye moon now');
    expect(run?.after.map((s) => 'say goodbye moon now'.slice(s.start, s.end))).toEqual(['goodbye moon']);
  });

  it('marks nothing when two lines are the same or have little in common', () => {
    expect(changedSpans('same', 'same')).toBeNull();
    expect(changedSpans('', 'added')).toBeNull();
    expect(changedSpans('return a + b;', 'export interface Thing {')).toBeNull();
  });

  it('marks a whole emoji, never half of one', () => {
    // Both are two code units that start with the same one; a mark over the second alone would draw two broken glyphs.
    const before = "  status: '\u{1F534}',";
    const after = "  status: '\u{1F7E2}',";
    const spans = changedSpans(before, after);
    expect(spans?.before.map((s) => before.slice(s.start, s.end))).toEqual(['\u{1F534}']);
    expect(spans?.after.map((s) => after.slice(s.start, s.end))).toEqual(['\u{1F7E2}']);
  });

  it('stops marking words once a diff has spent its share of work, and still pairs what fits', () => {
    const pair = (n: number): string[] => [`-const value${String(n)} = 1;`, `+const value${String(n)} = 2;`];
    const rows = parsePatch(['@@ -1,6 +1,6 @@', ...pair(1), ' keep', ...pair(2), ' keep', ...pair(3)].join('\n'));
    // Each pair is 8 tokens against 8: 64 cells. All three fit by default; a budget of 130 pays for two.
    expect(inlineSpans(rows).size).toBe(6);
    expect([...inlineSpans(rows, 130).keys()].sort((a, b) => a - b)).toEqual([1, 2, 4, 5]);
    expect(inlineSpans(rows, 0).size).toBe(0);
    // A pair too large for what is left is passed over; a smaller one after it is still marked.
    const wide = `const total = ${Array.from({ length: 30 }, (_, i) => `part${String(i)}`).join(' + ')};`;
    const mixed = parsePatch(['@@ -1,4 +1,4 @@', `-${wide}`, `+${wide.replace('part7', 'other')}`, ' keep', ...pair(4)].join('\n'));
    expect([...inlineSpans(mixed, 100).keys()].sort((a, b) => a - b)).toEqual([4, 5]);
  });

  it('puts each hunk’s lines together as the text before and the text after, hunk by hunk', () => {
    const rows = rowsFromHunks([
      { header: '@@ -1,3 +1,3 @@', lines: [' /**', '- * old', '+ * new'] },
      { header: '@@ -40,2 +40,3 @@', lines: [' const a = 1;', '+const b = 2;', ' done();'] }
    ]);
    const { texts, placeOf } = hunkTexts(rows);
    // The comment left open at the end of the first hunk is not carried into the second.
    expect(texts).toEqual([
      { before: '/**\n * old', after: '/**\n * new' },
      { before: 'const a = 1;\ndone();', after: 'const a = 1;\nconst b = 2;\ndone();' }
    ]);
    expect(placeOf).toEqual([
      null,
      { hunk: 0, side: 'after', line: 0 },
      { hunk: 0, side: 'before', line: 1 },
      { hunk: 0, side: 'after', line: 1 },
      null,
      { hunk: 1, side: 'after', line: 0 },
      { hunk: 1, side: 'after', line: 1 },
      { hunk: 1, side: 'after', line: 2 }
    ]);
    expect(hunkTexts([])).toEqual({ texts: [], placeOf: [] });
  });

  it('covers the lines of a diff that hold a key, and only those', () => {
    const key = `sk-ant-api03-${'a1B2c3D4'.repeat(6)}`;
    const env = parsePatch(['@@ -1,2 +1,3 @@', ' PORT=3000', '-ANTHROPIC_API_KEY=', `+ANTHROPIC_API_KEY=${key}`, ' DEBUG=1'].join('\n'));
    expect([...coveredRows(env)]).toEqual([[3, 'ANTHROPIC_API_KEY=sk-ant••••••••']]);
    expect(coveredRows(parsePatch(['@@ -1 +1 @@', '-const a = 1;', '+const a = 2;'].join('\n'))).size).toBe(0);

    // A private key is known by its first line; every line of it is covered, in the text it belongs to.
    const pem = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAA', 'AAAAB3NzaC1yc2EAAAADAQAB', '-----END OPENSSH PRIVATE KEY-----'];
    const added = parsePatch(['@@ -0,0 +1,5 @@', ...pem.map((line) => `+${line}`), '+# deploy key'].join('\n'));
    expect([...coveredRows(added).keys()]).toEqual([1, 2, 3, 4]);
    expect([...new Set(coveredRows(added).values())]).toEqual(['••••••••']);
    // Removed, it is covered on the removed side; the line kept after it is not.
    const removed = parsePatch(['@@ -1,5 +1,1 @@', ...pem.map((line) => `-${line}`), ' # deploy key'].join('\n'));
    expect([...coveredRows(removed).keys()]).toEqual([1, 2, 3, 4]);
  });

  it('pairs the removed and added lines of a change, one for one', () => {
    const rows = parsePatch(['@@ -1,4 +1,3 @@', ' keep', '-const a = 1;', '-const gone = true;', '+const a = 2;', ' tail'].join('\n'));
    const spans = inlineSpans(rows);
    // Rows: hunk, keep, del, del, add, tail. The first removed line pairs with the added one; the second has no partner.
    expect([...spans.keys()].sort()).toEqual([2, 4]);
    expect(spans.get(2)).toEqual([{ start: 10, end: 11 }]);
    expect(spans.get(4)).toEqual([{ start: 10, end: 11 }]);
  });

  it('cuts a line where its syntax tokens and its changed words begin and end', () => {
    // "const a = 2;" as tokens [const][ a ][=][ 2][;] with the 2 changed.
    const cut = pieces('const a = 2;', [5, 3, 1, 2, 1], [{ start: 10, end: 11 }]);
    expect(cut.map((p) => [p.text, p.token, p.changed])).toEqual([
      ['const', 0, false],
      [' a ', 1, false],
      ['=', 2, false],
      [' ', 3, false],
      ['2', 3, true],
      [';', 4, false]
    ]);
    // Without tokens the line is cut at the changed words only; tokens that do not add up to the line are ignored.
    expect(pieces('const a = 2;', null, [{ start: 10, end: 11 }]).map((p) => [p.text, p.token, p.changed])).toEqual([
      ['const a = ', -1, false],
      ['2', -1, true],
      [';', -1, false]
    ]);
    expect(pieces('abc', [1, 1], []).map((p) => [p.text, p.token])).toEqual([['abc', -1]]);
    expect(pieces('', null, [])).toEqual([]);
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

describe('chat files and code runs', () => {
  it('collects the files a reply made and names CreateFile and RunCode calls', () => {
    const created = call('CreateFile', { name: 'plan.md', content: '# Plan' }, { display: { kind: 'file', name: 'plan.md', size: 6, mime: 'text/markdown', preview: '# Plan' } });
    const ran = call('RunCode', { code: 'graft.writeFile("out.csv", "a")' }, {
      display: { kind: 'code', code: 'x', output: '', error: null, timedOut: false, durationMs: 5, files: [{ name: 'out.csv', size: 1, mime: 'text/csv' }] }
    });
    const failed = call('RunCode', { code: 'nope()' }, { isError: true, display: { kind: 'code', code: 'nope()', output: '', error: 'ReferenceError', timedOut: false, durationMs: 2, files: [] } });
    expect(madeFiles([created, ran, failed]).map((f) => f.name)).toEqual(['plan.md', 'out.csv']);
    expect(summarizeCalls([created, ran])).toBe('Created plan.md, ran code');
    expect(callParts(created)).toMatchObject({ verb: 'Created', target: 'plan.md' });
    expect(callParts(ran).verb).toBe('Ran code');
    expect(callParts(failed).verb).toBe('Ran code (failed)');
    expect(callParts(call('CreateFile', { name: 'x.txt', content: '' })).verb).toBe('Creating');
  });
});
