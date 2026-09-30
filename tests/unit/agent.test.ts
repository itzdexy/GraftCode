import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/main/providers/errors';
import { toLlmHistory } from '../../src/main/agent/history';
import { expandCommand, parseSlash } from '../../src/main/agent/slashCommands';
import { MemoryLoader } from '../../src/main/agent/memory';
import { renderTranscript } from '../../src/main/agent/compaction';
import type { StoredMessage } from '../../src/shared/schemas/messages';
import { fakeModel } from '../support/fakeProvider';
import { makeHarness, type Harness } from '../support/sessionHarness';
import { removeDir, writeFile } from '../support/tmp';

let harnesses: Harness[] = [];
function harness(...args: Parameters<typeof makeHarness>): Harness {
  const h = makeHarness(...args);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses) {
    await h.session.dispose();
    removeDir(h.projectDir);
    removeDir(h.home);
  }
  harnesses = [];
});

const texts = (h: Harness) => h.store.listMessages('session-1').map((m) => `${m.role}:${m.content.map((b) => (b.type === 'text' ? b.text : b.type)).join('|')}`);
const lastRequest = (h: Harness) => h.provider.requests.at(-1)!;

describe('agent turns', () => {
  it('answers a plain message, records usage and requests a title once', async () => {
    const h = harness({ script: [{ text: 'Hello there!', usage: { inputTokens: 1000, outputTokens: 50 } }] });
    h.session.send('hi');
    await h.session.idle();
    expect(texts(h)).toEqual(['user:hi', 'assistant:Hello there!']);
    expect(h.session.summary.status).toBe('idle');
    expect(h.session.summary.usage).toMatchObject({ contextTokens: 1050, contextLimit: 100_000, totals: { inputTokens: 1000, outputTokens: 50 } });
    expect(h.events.map((e) => e.type)).toEqual(expect.arrayContaining(['turn-start', 'assistant-start', 'assistant-delta', 'message', 'usage', 'turn-end']));
    expect(h.titles).toEqual(['hi']);
    expect(lastRequest(h).system).toContain('You are Graft');
    expect(lastRequest(h).tools.map((t) => t.name)).toContain('Edit');
  });

  it('runs a read-only tool without asking and feeds the result back', async () => {
    const h = harness({
      script: [{ text: 'Reading.', toolCalls: [{ name: 'Read', input: { file_path: 'notes.txt' } }] }, { text: 'It says hello.' }]
    });
    writeFile(h.projectDir, 'notes.txt', 'hello world\n');
    h.session.send('what is in notes.txt?');
    await h.session.idle();
    expect(h.events.some((e) => e.type === 'permission')).toBe(false);
    const second = h.provider.requests[1]!;
    const toolResult = second.messages.at(-1)!.content[0];
    expect(toolResult).toMatchObject({ type: 'tool_result', isError: false });
    expect(JSON.stringify(toolResult)).toContain('hello world');
    expect(JSON.stringify(toolResult)).not.toContain('"display"');
    expect(texts(h).at(-1)).toBe('assistant:It says hello.');
  });

  it('asks before editing in Ask mode, then applies the edit when approved', async () => {
    const h = harness({
      script: [
        { toolCalls: [{ name: 'Read', input: { file_path: 'a.ts' } }] },
        { toolCalls: [{ name: 'Edit', input: { file_path: 'a.ts', old_string: 'one', new_string: 'two' } }] },
        { text: 'Changed it.' }
      ]
    });
    writeFile(h.projectDir, 'a.ts', 'const x = "one";\n');
    h.session.send('change one to two');
    const event = await h.waitFor((e) => e.type === 'permission');
    if (event.type !== 'permission') throw new Error('unreachable');
    expect(event.request).toMatchObject({ toolName: 'Edit', detail: { kind: 'edit' }, suggestedRule: 'Edit(**)', dangerous: null });
    expect(h.session.detail().summary.status).toBe('needs-input');
    expect(h.notifications.at(-1)?.kind).toBe('needs-input');
    h.session.respondPermission({ requestId: event.request.id, decision: 'allow-once' });
    await h.session.idle();
    expect(fs.readFileSync(path.join(h.projectDir, 'a.ts'), 'utf8')).toBe('const x = "two";\n');
    expect(texts(h).at(-1)).toBe('assistant:Changed it.');
  });

  it('passes denial feedback to the model and remembers "allow for session"', async () => {
    const h = harness({
      script: [
        { toolCalls: [{ name: 'Write', input: { file_path: 'x.txt', content: 'a' } }] },
        { toolCalls: [{ name: 'Write', input: { file_path: 'y.txt', content: 'b' } }] },
        { toolCalls: [{ name: 'Write', input: { file_path: 'z.txt', content: 'c' } }] },
        { text: 'ok' }
      ]
    });
    h.session.send('write files');
    const first = await h.waitFor((e) => e.type === 'permission');
    if (first.type !== 'permission') throw new Error('unreachable');
    h.session.respondPermission({ requestId: first.request.id, decision: 'deny', feedback: 'Use snake_case names' });
    const second = await h.waitFor((e) => e.type === 'permission' && e.request.id !== first.request.id);
    if (second.type !== 'permission') throw new Error('unreachable');
    expect(JSON.stringify(h.provider.requests[1]!.messages.at(-1))).toContain('Use snake_case names');
    h.session.respondPermission({ requestId: second.request.id, decision: 'allow-session' });
    await h.session.idle();
    expect(h.events.filter((e) => e.type === 'permission')).toHaveLength(2);
    expect(fs.existsSync(path.join(h.projectDir, 'z.txt'))).toBe(true);
    expect(fs.existsSync(path.join(h.projectDir, 'x.txt'))).toBe(false);
  });

  it('runs safe calls from one response in parallel and keeps result order', async () => {
    const h = harness({
      script: [
        {
          toolCalls: [
            { name: 'Read', input: { file_path: 'a.txt' } },
            { name: 'Glob', input: { pattern: '*.txt' } },
            { name: 'Read', input: { file_path: 'b.txt' } }
          ]
        },
        { text: 'done' }
      ]
    });
    writeFile(h.projectDir, 'a.txt', 'AAA');
    writeFile(h.projectDir, 'b.txt', 'BBB');
    h.session.send('look around');
    await h.session.idle();
    const results = h.provider.requests[1]!.messages.at(-1)!.content;
    expect(results).toHaveLength(3);
    expect(JSON.stringify(results[0])).toContain('AAA');
    expect(JSON.stringify(results[2])).toContain('BBB');
  });
});

describe('cancellation, retries and errors', () => {
  it('interrupts mid-stream, keeps the partial reply and can continue afterwards', async () => {
    const h = harness({ script: [{ text: 'word '.repeat(200), chunkDelayMs: 15 }, { text: 'Fresh answer.' }] });
    h.session.send('write a lot');
    await h.waitFor((e) => e.type === 'assistant-delta');
    h.session.interrupt();
    await h.session.idle();
    const end = h.events.find((e) => e.type === 'turn-end');
    expect(end).toMatchObject({ reason: 'interrupted' });
    const partial = h.store.listMessages('session-1').at(-1)!;
    expect(partial.meta.interrupted).toBe(true);
    expect(h.session.summary.status).toBe('idle');
    h.session.send('continue');
    await h.session.idle();
    expect(texts(h).at(-1)).toBe('assistant:Fresh answer.');
  });

  it('interrupts a running tool and records the call as interrupted', async () => {
    const h = harness({
      mode: 'bypass',
      script: [{ toolCalls: [{ name: 'Shell', input: { command: process.platform === 'win32' ? 'sleep 30' : 'sleep 30' } }] }, { text: 'never' }]
    });
    h.session.send('wait');
    await h.waitFor((e) => e.type === 'tool-start');
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    h.session.interrupt();
    await h.session.idle();
    expect(Date.now() - started).toBeLessThan(10_000);
    const results = h.store.listMessages('session-1').at(-1)!;
    expect(JSON.stringify(results.content)).toMatch(/Interrupted/);
    expect(h.provider.remaining).toBe(1);
    const replay = toLlmHistory(h.store.listMessages('session-1'));
    expect(replay.at(-1)?.role).toBe('user');
  });

  it('retries overloaded responses before the first byte, then succeeds', async () => {
    const h = harness({ script: [{ error: new ProviderError('overloaded', 'busy') }, { text: 'Back online.' }] });
    h.session.send('hello');
    await h.session.idle();
    expect(h.events.filter((e) => e.type === 'retrying')).toHaveLength(1);
    expect(texts(h).at(-1)).toBe('assistant:Back online.');
  });

  it('surfaces a failed turn as an error with context, and retry() recovers', async () => {
    const h = harness({
      script: [
        { error: new ProviderError('server', 'upstream 500') },
        { error: new ProviderError('server', 'upstream 500') },
        { error: new ProviderError('server', 'upstream 500') },
        { text: 'Recovered.' }
      ]
    });
    h.session.send('hello');
    await h.session.idle();
    expect(h.session.detail().summary.status).toBe('error');
    expect(h.session.summary.lastError).toMatchObject({ code: 'server', message: 'upstream 500' });
    expect(h.notifications.at(-1)?.kind).toBe('error');
    h.session.retry();
    await h.session.idle();
    expect(h.session.summary.status).toBe('idle');
    expect(texts(h)).toEqual(['user:hello', 'assistant:Recovered.']);
  });

  it('keeps partial text when the stream fails after output started', async () => {
    const h = harness({ script: [{ error: new ProviderError('network', 'socket hang up'), partialText: 'Half an ans' }] });
    h.session.send('go');
    await h.session.idle();
    const last = h.store.listMessages('session-1').at(-1)!;
    expect(last.content).toEqual([{ type: 'text', text: 'Half an ans' }]);
    expect(last.meta.error).toMatchObject({ code: 'network' });
  });

  it('stops a loop that keeps repeating the same calls', async () => {
    const same = { toolCalls: [{ name: 'Glob', input: { pattern: '*.md' } }] };
    const h = harness({ script: [same, same, same, same, same, same, same, same] });
    h.session.send('loop');
    await h.session.idle();
    expect(h.events.find((e) => e.type === 'turn-end')).toMatchObject({ reason: 'guard' });
    expect(h.events.some((e) => e.type === 'notice' && /repeating/.test(e.text))).toBe(true);
    expect(JSON.stringify(h.provider.requests.at(-1)?.messages.at(-1))).toContain('same tool calls three times');
  });

  it('queues messages sent while a turn runs and sends them afterwards', async () => {
    const h = harness({ script: [{ text: 'first answer', chunkDelayMs: 5 }, { text: 'second answer' }] });
    h.session.send('one');
    expect(h.session.send('two')).toEqual({ queued: true });
    expect(h.events.some((e) => e.type === 'queue' && e.queue.length === 1)).toBe(true);
    await h.session.idle();
    await h.session.idle();
    expect(texts(h)).toEqual(['user:one', 'assistant:first answer', 'user:two', 'assistant:second answer']);
  });
});

describe('compaction', () => {
  it('summarizes near the context limit and continues from the summary', async () => {
    const h = harness({
      model: { contextWindow: 2000 },
      script: [
        { toolCalls: [{ name: 'Glob', input: { pattern: '*' } }], usage: { inputTokens: 1700, outputTokens: 20 } },
        { text: '## Goal\nKeep going. Files: src/a.ts' },
        { text: 'Continuing after compaction.' }
      ]
    });
    h.session.send('big task');
    await h.session.idle();
    const messages = h.store.listMessages('session-1');
    const summary = messages.find((m) => m.meta.kind === 'compaction-summary');
    expect(summary).toBeDefined();
    expect(messages.filter((m) => m.meta.compacted).length).toBeGreaterThanOrEqual(3);
    const summarizeRequest = h.provider.requests[1]!;
    expect(summarizeRequest.tools).toEqual([]);
    expect(summarizeRequest.system).toMatch(/summarize a coding session/);
    const after = h.provider.requests[2]!;
    expect(after.messages).toHaveLength(1);
    expect(JSON.stringify(after.messages[0])).toContain('This session was compacted');
    expect(h.events.some((e) => e.type === 'compacted')).toBe(true);
  });

  it('compacts on /compact and reports when there is nothing to compact', async () => {
    const h = harness({ script: [{ text: 'answer' }, { text: 'Summary: the user said hi.' }] });
    h.session.send('/compact');
    await h.session.idle();
    expect(texts(h).at(-1)).toMatch(/Nothing to compact/);
    h.session.send('hi');
    await h.session.idle();
    h.session.send('/compact keep the greeting');
    await h.session.idle();
    expect(JSON.stringify(h.provider.requests.at(-1)?.messages)).toContain('keep the greeting');
    expect(toLlmHistory(h.store.listMessages('session-1'))).toHaveLength(1);
  });
});

describe('agent tools that involve the user', () => {
  it('asks questions and returns the answers to the model', async () => {
    const h = harness({
      script: [
        { toolCalls: [{ name: 'AskUserQuestion', input: { questions: [{ question: 'Which DB?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }] } }] },
        { text: 'Going with it.' }
      ]
    });
    h.session.send('set up storage');
    const q = await h.waitFor((e) => e.type === 'question');
    if (q.type !== 'question') throw new Error('unreachable');
    expect(h.session.detail().pendingQuestion?.questions[0]?.question).toBe('Which DB?');
    h.session.answerQuestion({ requestId: q.request.id, answers: [{ selected: ['Postgres'] }] });
    await h.session.idle();
    expect(JSON.stringify(h.provider.requests[1]!.messages.at(-1))).toContain('A: Postgres');
  });

  it('blocks writes in plan mode until the plan is approved', async () => {
    const h = harness({
      mode: 'plan',
      script: [
        { toolCalls: [{ name: 'Write', input: { file_path: 'plan.txt', content: 'x' } }] },
        { toolCalls: [{ name: 'ExitPlanMode', input: { plan: '1. Write plan.txt' } }] },
        { toolCalls: [{ name: 'Write', input: { file_path: 'plan.txt', content: 'x' } }] },
        { text: 'Done.' }
      ]
    });
    h.session.send('make a file');
    const prompt = await h.waitFor((e) => e.type === 'permission');
    if (prompt.type !== 'permission') throw new Error('unreachable');
    expect(prompt.request.detail).toEqual({ kind: 'plan', plan: '1. Write plan.txt' });
    expect(JSON.stringify(h.provider.requests[1]!.messages.at(-1))).toContain('Plan mode is read-only');
    h.session.respondPermission({ requestId: prompt.request.id, decision: 'allow-once' });
    await h.session.idle();
    expect(h.session.summary.permissionMode).toBe('auto-edit');
    expect(fs.readFileSync(path.join(h.projectDir, 'plan.txt'), 'utf8')).toBe('x');
  });

  it('delegates to a read-only sub-agent with its own context', async () => {
    const h = harness({
      script: [
        { toolCalls: [{ name: 'Task', input: { description: 'Find config', prompt: 'Where is the config loaded?', subagent_type: 'explore' } }] },
        { text: 'Report: config is loaded in src/config.ts:12' },
        { text: 'The sub-agent found it.' }
      ]
    });
    h.session.send('where is config loaded?');
    await h.session.idle();
    const child = h.provider.requests[1]!;
    expect(child.system).toContain('Delegated task');
    expect(child.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Where is the config loaded?' }] }]);
    expect(child.tools.map((t) => t.name).sort()).toEqual(['Glob', 'Grep', 'Read', 'WebFetch']);
    expect(JSON.stringify(h.provider.requests[2]!.messages.at(-1))).toContain('src/config.ts:12');
    expect(texts(h).filter((t) => t.includes('Report:'))).toEqual([]);
  });

  it('runs a PreToolUse hook that blocks shell commands', async () => {
    const h = harness({
      mode: 'bypass',
      hooks: { PreToolUse: [{ matcher: 'Shell', hooks: [{ type: 'command', command: 'echo "no shells today" >&2; exit 2' }], scope: 'user' }] },
      script: [{ toolCalls: [{ name: 'Shell', input: { command: 'echo hi' } }] }, { text: 'ok' }]
    });
    h.session.send('run something');
    await h.session.idle();
    expect(JSON.stringify(h.provider.requests[1]!.messages.at(-1))).toContain('no shells today');
  });

  it('adds a verification pass in Taproot mode', async () => {
    const h = harness({
      effort: 'taproot',
      script: [{ toolCalls: [{ name: 'Glob', input: { pattern: '*' } }] }, { text: 'All done.' }, { text: 'Verified: tests pass.' }]
    });
    h.session.send('build it');
    await h.session.idle();
    expect(JSON.stringify(h.provider.requests[2]!.messages.at(-1))).toContain('Before you finish: verify the work');
    expect(texts(h).at(-1)).toBe('assistant:Verified: tests pass.');
  });
});

describe('commands, memory and history', () => {
  it('handles built-in and custom slash commands without calling the model when not needed', async () => {
    const h = harness({ script: [{ text: 'Greeted Ada.' }] });
    writeFile(h.projectDir, '.graft/commands/greet.md', '---\ndescription: Say hi\n---\nGreet $ARGUMENTS warmly.');
    h.session.send('/cost');
    await h.session.idle();
    h.session.send('/nope');
    await h.session.idle();
    expect(h.provider.requests).toHaveLength(0);
    h.session.send('/greet Ada');
    await h.session.idle();
    const user = h.store.listMessages('session-1').filter((m) => m.role === 'user').at(-1)!;
    expect(user.content.at(-1)).toEqual({ type: 'text', text: 'Greet Ada warmly.' });
    expect(user.meta.typed).toBe('/greet Ada');
    expect(parseSlash('/review  focus on auth')).toEqual({ name: 'review', args: 'focus on auth' });
    expect(expandCommand({ name: 'x', description: '', argumentHint: null, source: 'user', path: null, body: 'Fix $1 then $2' }, 'a b')).toBe('Fix a then b');
  });

  it('includes project notes in the system prompt and loads nested notes lazily', async () => {
    const h = harness({ script: [{ toolCalls: [{ name: 'Read', input: { file_path: 'pkg/api/x.ts' } }] }, { text: 'ok' }] });
    writeFile(h.projectDir, 'GRAFT.md', 'Use 2-space indentation.');
    writeFile(h.projectDir, 'pkg/api/AGENTS.md', 'API handlers must validate input.');
    writeFile(h.projectDir, 'pkg/api/x.ts', 'export {}');
    h.session.send('check x');
    await h.session.idle();
    expect(h.provider.requests[0]!.system).toContain('Use 2-space indentation.');
    expect(JSON.stringify(h.provider.requests[1]!.messages.at(-1))).toContain('API handlers must validate input.');
    const loader = new MemoryLoader(h.home, h.projectDir);
    loader.initial(h.projectDir);
    expect(loader.notesFor([path.join(h.projectDir, 'pkg/api/x.ts')])).toContain('validate input');
    expect(loader.notesFor([path.join(h.projectDir, 'pkg/api/y.ts')])).toBeNull();
  });

  it('drops replayed thinking after switching models and repairs unanswered tool calls', async () => {
    const other = fakeModel({ ref: { providerId: 'fake', modelId: 'other-model' } });
    const h = harness({
      models: [fakeModel(), other],
      script: [{ thinking: 'secret reasoning', text: 'first' }, { text: 'second' }]
    });
    h.session.send('one');
    await h.session.idle();
    h.session.setModel(other.ref, 'medium');
    h.session.send('two');
    await h.session.idle();
    expect(JSON.stringify(h.provider.requests[1]!.messages)).not.toContain('secret reasoning');

    const stored: StoredMessage[] = [
      { id: 'a', sessionId: 's', seq: 1, role: 'user', content: [{ type: 'text', text: 'go' }], meta: {}, createdAt: 0 },
      { id: 'b', sessionId: 's', seq: 2, role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }], meta: {}, createdAt: 0 },
      { id: 'c', sessionId: 's', seq: 3, role: 'user', content: [{ type: 'text', text: 'next' }], meta: {}, createdAt: 0 }
    ];
    const replay = toLlmHistory(stored);
    expect(replay[2]?.content[0]).toMatchObject({ type: 'tool_result', toolUseId: 't1', isError: true });
    expect(renderTranscript(replay, 10_000)).toContain('[called Read');
  });

  it('chat sessions have no tools and use the chat prompt', async () => {
    const h = harness({ kind: 'chat', script: [{ text: 'Hi Tester!' }] });
    h.session.send('hello');
    await h.session.idle();
    expect(h.provider.requests[0]!.tools).toEqual([]);
    expect(h.provider.requests[0]!.system).toMatch(/assistant in the Graft desktop app/);
    expect(h.provider.requests[0]!.system).toContain("The user's name is Tester");
  });
});

describe('auto-titling', () => {
  it('cleans model titles and prefers the fast tier', async () => {
    const { cleanTitle, generateTitle, titleModel } = await import('../../src/main/agent/title');
    expect(cleanTitle('"Fix the login bug."\nextra')).toBe('Fix the login bug');
    expect(cleanTitle('Title: Refactor parser')).toBe('Refactor parser');
    expect(cleanTitle('   ')).toBeNull();
    expect(cleanTitle('x'.repeat(80))?.length).toBe(58);
    const main = fakeModel();
    const fast = fakeModel({ ref: { providerId: 'fake', modelId: 'fast-mini' }, cheap: true });
    expect(titleModel(main, [main, fast]).ref.modelId).toBe('fast-mini');
    expect(titleModel(main, [main]).ref.modelId).toBe('fake-model');
    const { FakeProvider } = await import('../support/fakeProvider');
    const provider = new FakeProvider([{ text: 'Debugging flaky websocket tests' }]);
    expect(await generateTitle(provider, main, 'my websocket tests fail randomly', new AbortController().signal)).toBe(
      'Debugging flaky websocket tests'
    );
    expect(provider.requests[0]!.tools).toEqual([]);
  });
});
