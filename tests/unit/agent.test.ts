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
import { makeTempDir, removeDir, writeFile } from '../support/tmp';

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
    // Regression: tool results are stored as user messages and must not block titling.
    expect(h.titles).toEqual(['what is in notes.txt?']);
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

  it('stores the typed text for display while the model also gets notes and @ attachments', async () => {
    const h = harness({ script: [{ text: 'ok' }] });
    writeFile(h.projectDir, 'notes.md', 'remember the red door');
    h.session.setPermissionMode('plan');
    h.session.send('summarize @notes.md');
    await h.session.idle();
    const user = h.store.listMessages('session-1')[0]!;
    expect(user.meta.typed).toBe('summarize @notes.md');
    const sent = JSON.stringify(lastRequest(h).messages[0]);
    expect(sent).toContain('remember the red door');
    expect(sent).toContain('<file path=\\"notes.md\\">');
    expect(sent.toLowerCase()).toContain('plan');
  });

  it('sends attached text files to the model as tagged blocks and keeps only their names for display', async () => {
    const h = harness({ script: [{ text: 'ok' }, { text: 'ok again' }] });
    h.session.send('what does this say?', [], [{ name: 'log "1".txt', content: 'line one\nline two' }]);
    await h.session.idle();
    const user = h.store.listMessages('session-1')[0]!;
    expect(user.meta.typed).toBe('what does this say?');
    expect(user.meta.attachments).toEqual(['log "1".txt']);
    const blocks = h.provider.requests[0]!.messages[0]!.content as { type: string; text?: string }[];
    const file = blocks.find((b) => b.text?.startsWith('<attached-file'));
    expect(file?.text).toBe(`<attached-file name="log '1'.txt">\nline one\nline two\n</attached-file>`);
    // A message may be only an attachment.
    expect(() => h.session.send('', [], [{ name: 'a.txt', content: 'x' }])).not.toThrow();
    await h.session.idle();
  });

  it('a worktree session uses its trusted project’s local allow rules (regression: trust was looked up on the worktree)', async () => {
    const project = makeTempDir();
    const worktree = makeTempDir();
    writeFile(worktree, 'notes.txt', 'hello\n');
    writeFile(project, '.graft/settings.local.json', JSON.stringify({ permissions: { allow: ['Edit(**)'] } }));
    const h = harness({
      projectDir: project,
      worktreeDir: worktree,
      trusted: (root) => path.resolve(root) === path.resolve(project),
      script: [
        { toolCalls: [{ name: 'Read', input: { file_path: 'notes.txt' } }] },
        { toolCalls: [{ name: 'Edit', input: { file_path: 'notes.txt', old_string: 'hello', new_string: 'hi' } }] },
        { text: 'Done.' }
      ]
    });
    h.session.send('edit it');
    await h.session.idle();
    expect(h.events.some((e) => e.type === 'permission')).toBe(false);
    expect(fs.readFileSync(path.join(worktree, 'notes.txt'), 'utf8')).toBe('hi\n');
    removeDir(worktree);
  });

  it('regenerate() replaces the last reply with a new answer to the same message', async () => {
    const h = harness({ kind: 'chat', script: [{ text: 'First answer.' }, { text: 'Second answer.' }] });
    h.session.send('question');
    await h.session.idle();
    expect(texts(h)).toEqual(['user:question', 'assistant:First answer.']);
    h.session.regenerate();
    await h.session.idle();
    expect(texts(h)).toEqual(['user:question', 'assistant:Second answer.']);
    expect(lastRequest(h).messages.at(-1)?.role).toBe('user');
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

  it('prices cache reads and writes at their own rates and keeps the context meter on the conversation', async () => {
    const h = harness({
      model: { pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
      script: [
        {
          toolCalls: [{ name: 'Task', input: { description: 'Look', prompt: 'Look around', subagent_type: 'explore' } }],
          usage: { inputTokens: 1000, cacheReadTokens: 10_000, cacheWriteTokens: 2000, outputTokens: 100 }
        },
        { text: 'Report: nothing here', usage: { inputTokens: 50_000, outputTokens: 10 } },
        { text: 'Done.', usage: { inputTokens: 500, cacheReadTokens: 12_000, outputTokens: 20 } }
      ]
    });
    h.session.send('look around');
    await h.session.idle();
    // The sub-agent's own 50K-token context doesn't replace the conversation's.
    const meters = h.events.flatMap((e) => (e.type === 'usage' ? [e.usage.contextTokens] : []));
    expect(meters).toEqual([13_100, 13_100, 12_520]);
    const expected = (1000 * 3 + 10_000 * 0.3 + 2000 * 3.75 + 100 * 15 + 50_000 * 3 + 10 * 15 + 500 * 3 + 12_000 * 0.3 + 20 * 15) / 1_000_000;
    expect(h.session.summary.usage.costUsd).toBeCloseTo(expected, 10);
    expect(h.session.summary.usage.totals.inputTokens).toBe(51_500);
  });

  it('an incognito chat asks for zero retention, names itself locally and leaves the name out', async () => {
    const h = harness({ kind: 'chat', incognito: true, script: [{ text: 'Sure.' }] });
    h.session.send('Plan a weekend in Lisbon');
    await h.session.idle();
    expect(lastRequest(h).privacy).toEqual({ noTraining: true, zeroRetention: true });
    expect(lastRequest(h).system).not.toContain('Tester');
    expect(h.titles).toEqual([]);
    expect(h.session.summary.title).toBe('Plan a weekend in Lisbon');
    expect(h.provider.requests).toHaveLength(1);
  });

  it('a saved chat follows the training setting and keeps its usual title and name', async () => {
    const h = harness({ kind: 'chat', noTraining: true, script: [{ text: 'Sure.' }] });
    h.session.send('Plan a weekend in Lisbon');
    await h.session.idle();
    expect(lastRequest(h).privacy).toEqual({ noTraining: true, zeroRetention: false });
    expect(lastRequest(h).system).toContain("The user's name is Tester.");
    expect(h.titles).toEqual(['Plan a weekend in Lisbon']);
  });

  it('with "local models only", an incognito chat refuses a cloud model and uses a local one', async () => {
    const cloud = harness({ kind: 'chat', incognito: true, incognitoLocalOnly: true, dataHandling: 'routed', script: [{ text: 'Sure.' }] });
    cloud.session.send('hello');
    await cloud.session.idle();
    expect(cloud.provider.requests).toHaveLength(0);
    expect(cloud.session.summary.status).toBe('error');
    expect(cloud.session.summary.lastError?.message).toMatch(/only models on this computer/);

    const local = harness({ kind: 'chat', incognito: true, incognitoLocalOnly: true, dataHandling: 'local', script: [{ text: 'Sure.' }] });
    local.session.send('hello');
    await local.session.idle();
    expect(local.provider.requests).toHaveLength(1);
    expect(local.session.summary.status).toBe('idle');
  });

  it('gives chats web search and page reading without asking; incognito chats get neither', async () => {
    const search = {
      active: () => 'brave' as const,
      search: () => Promise.resolve({ engine: 'brave' as const, results: [{ title: 'Rivals', url: 'https://rivals.example/a', snippet: 'Fast PvP.' }] })
    };
    const h = harness({
      kind: 'chat',
      webSearch: true,
      search,
      script: [{ toolCalls: [{ name: 'WebSearch', input: { query: 'roblox rivals history' } }] }, { text: 'RIVALS began as a zombie game.' }]
    });
    h.session.send('search the history of rivals');
    await h.session.idle();
    expect(h.provider.requests[0]!.tools.map((t) => t.name).sort()).toEqual(['WebFetch', 'WebSearch']);
    expect(h.provider.requests[0]!.system).toContain('search the web');
    expect(h.events.some((e) => e.type === 'permission')).toBe(false);
    expect(JSON.stringify(h.provider.requests[1]!.messages.at(-1))).toContain('rivals.example');

    const incognito = harness({ kind: 'chat', incognito: true, webSearch: true, search, script: [{ text: 'ok' }] });
    incognito.session.send('hi');
    await incognito.session.idle();
    expect(incognito.provider.requests[0]!.tools).toEqual([]);
    expect(incognito.provider.requests[0]!.system).toContain('no tools');
  });

  it('offers WebSearch to code sessions only when a search engine is set up', async () => {
    const without = harness({ webSearch: true, script: [{ text: 'ok' }] });
    without.session.send('hi');
    await without.session.idle();
    expect(without.provider.requests[0]!.tools.map((t) => t.name)).not.toContain('WebSearch');
    const withEngine = harness({ webSearch: true, search: { active: () => 'tavily', search: () => Promise.reject(new Error('unused')) }, script: [{ text: 'ok' }] });
    withEngine.session.send('hi');
    await withEngine.session.idle();
    expect(withEngine.provider.requests[0]!.tools.map((t) => t.name)).toContain('WebSearch');
  });

  it('gives chats CreateFile and RunCode and the time each message was sent; incognito chats and code sessions get neither tool', async () => {
    const saved: string[] = [];
    const work = {
      chatFiles: { save: (_id: string, name: string, data: Buffer) => (saved.push(name), { name, path: `/files/${name}`, size: data.length, mime: 'text/plain' }) },
      runCode: () => Promise.resolve({ output: '', error: null, timedOut: false, durationMs: 1, files: [] })
    };
    const chat = harness({
      kind: 'chat',
      ...work,
      script: [{ toolCalls: [{ name: 'CreateFile', input: { name: 'notes.txt', content: 'hi' } }] }, { text: 'Made notes.txt.' }]
    });
    chat.session.send('make me a notes file');
    await chat.session.idle();
    const first = chat.provider.requests[0]!;
    expect(first.tools.map((t) => t.name).sort()).toEqual(['CreateFile', 'RunCode']);
    expect(first.system).toContain('CreateFile saves a file');
    expect(JSON.stringify(first.messages[0])).toMatch(/\[Sent \w{3}, \w{3} \d{1,2}, \d{4}, \d{1,2}:\d{2}/);
    expect(saved).toEqual(['notes.txt']);
    expect(chat.events.some((e) => e.type === 'permission')).toBe(false);

    const incognito = harness({ kind: 'chat', incognito: true, ...work, script: [{ text: 'ok' }] });
    incognito.session.send('hi');
    await incognito.session.idle();
    expect(incognito.provider.requests[0]!.tools).toEqual([]);

    const code = harness({ ...work, script: [{ text: 'ok' }] });
    code.session.send('hi');
    await code.session.idle();
    const names = code.provider.requests[0]!.tools.map((t) => t.name);
    expect(names).not.toContain('CreateFile');
    expect(names).not.toContain('RunCode');
    expect(JSON.stringify(code.provider.requests[0]!.messages[0])).not.toContain('[Sent ');
  });

  it('runs a model’s built-in search only when its provider is the chosen engine; free search goes through WebSearch', async () => {
    const run = async (active: 'exa' | 'anthropic' | null): Promise<{ native: boolean; tools: string[] }> => {
      const h = harness({
        kind: 'chat',
        webSearch: true,
        model: { supportsWebSearch: true },
        search: { active: () => active, search: () => Promise.reject(new Error('unused')) },
        script: [{ text: 'ok' }]
      });
      h.session.send('hi');
      await h.session.idle();
      return { native: h.provider.requests[0]!.webSearch, tools: h.provider.requests[0]!.tools.map((t) => t.name) };
    };
    expect(await run('exa')).toEqual({ native: false, tools: ['WebFetch', 'WebSearch'] });
    expect(await run('anthropic')).toEqual({ native: true, tools: ['WebFetch'] });
    expect(await run(null)).toEqual({ native: false, tools: ['WebFetch'] });
  });

  it('runs a chat set to Taproot at the model’s strongest level, without the code-session review pass', async () => {
    const h = harness({ kind: 'chat', effort: 'taproot', script: [{ text: 'Sure.' }] });
    h.session.send('hi');
    await h.session.idle();
    expect(lastRequest(h).effort).toBe('high');
    expect(h.provider.requests).toHaveLength(1);
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

  it('adds a verification pass in Taproot mode once the turn changed something', async () => {
    const h = harness({
      effort: 'taproot',
      mode: 'auto-edit',
      script: [{ toolCalls: [{ name: 'Write', input: { file_path: 'feature.ts', content: 'export const on = true;\n' } }] }, { text: 'All done.' }, { text: 'Verified: tests pass.' }]
    });
    h.session.send('build it');
    await h.session.idle();
    // A session that starts in Taproot gets the working protocol with its first message.
    expect(JSON.stringify(h.provider.requests[0]!.messages[0])).toContain('[Taproot mode is on');
    expect(JSON.stringify(h.provider.requests[2]!.messages.at(-1))).toContain('Before you finish, verify the work end to end');
    expect(texts(h).at(-1)).toBe('assistant:Verified: tests pass.');
  });

  it('just answers a question in Taproot: no review pass after read-only commands, no nudges for older tasks', async () => {
    const h = harness({
      effort: 'taproot',
      mode: 'bypass',
      script: [{ toolCalls: [{ name: 'Shell', input: { command: 'date' } }] }, { text: 'It is 3:04 PM.' }, { text: 'never' }]
    });
    // Open tasks left from an earlier piece of work.
    h.store.updateSession('session-1', { todos: [{ id: '1', content: 'Old unfinished task', status: 'pending' }] });
    h.session.send('what time is it');
    await h.session.idle();
    expect(h.provider.requests).toHaveLength(2);
    expect(texts(h).at(-1)).toBe('assistant:It is 3:04 PM.');
    expect(h.provider.remaining).toBe(1);
  });

  it('sends a Taproot turn back to its open tasks before it may finish, once briefed', async () => {
    const todos = (status: 'pending' | 'completed') => ({
      todos: [
        { id: '1', content: 'Add the parser', status },
        { id: '2', content: 'Cover it with tests', status }
      ]
    });
    const h = harness({
      effort: 'taproot',
      script: [
        { toolCalls: [{ name: 'TodoWrite', input: todos('pending') }] },
        { text: 'Done, I think.' },
        { toolCalls: [{ name: 'TodoWrite', input: todos('completed') }] },
        { text: 'All tasks finished.' },
        { text: 'Verified: 12 tests pass.' },
        { text: 'Again.' }
      ]
    });
    h.session.send('build the parser');
    await h.session.idle();
    const nudge = JSON.stringify(h.provider.requests[2]!.messages.at(-1));
    expect(nudge).toContain('You still have open tasks');
    expect(nudge).toContain('Cover it with tests');
    expect(JSON.stringify(h.provider.requests[4]!.messages.at(-1))).toContain('Before you finish, verify the work end to end');
    expect(texts(h).at(-1)).toBe('assistant:Verified: 12 tests pass.');

    // The briefing goes out once per session.
    h.session.send('one more thing');
    await h.session.idle();
    const second = h.provider.requests.at(-1)!.messages.filter((m) => JSON.stringify(m).includes('[Taproot mode is on'));
    expect(second).toHaveLength(1);
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

  it('tells the model which model and provider it is, and updates that after a switch (regression: "powered by OpenAI" on OpenRouter)', async () => {
    const other = fakeModel({ ref: { providerId: 'fake', modelId: 'other-model' }, label: 'Other Model' });
    const h = harness({ kind: 'chat', models: [fakeModel(), other], script: [{ text: 'one' }, { text: 'two' }] });
    h.session.send('which model are you?');
    await h.session.idle();
    expect(h.provider.requests[0]!.system).toContain('You are running on the model Fake Model (id "fake-model"), served through Fake Provider.');
    h.session.setModel(other.ref, 'medium');
    h.session.send('and now?');
    await h.session.idle();
    expect(h.provider.requests[1]!.system).toContain('Other Model (id "other-model")');
    expect(h.provider.requests[1]!.system).not.toContain('Fake Model');
  });

  it('cycles into Bypass only once it is switched on in Settings', () => {
    const off = harness({ script: [], mode: 'auto' });
    expect(off.session.cyclePermissionMode()).toBe('ask');
    const on = harness({ script: [], mode: 'auto', bypassEnabled: true });
    expect(on.session.cyclePermissionMode()).toBe('bypass');
    expect(on.session.cyclePermissionMode()).toBe('ask');
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

  it('adds Settings → Personalization to chat and code prompts, and leaves it out of incognito chats', async () => {
    const personalization = { about: 'I am a data engineer who writes Python.', instructions: 'Use British spelling.', style: 'concise' as const };
    const chat = harness({ kind: 'chat', personalization, script: [{ text: 'ok' }] });
    chat.session.send('hello');
    await chat.session.idle();
    const chatSystem = chat.provider.requests[0]!.system;
    expect(chatSystem).toContain("# The user's preferences");
    expect(chatSystem).toContain('<about-the-user>\nI am a data engineer who writes Python.\n</about-the-user>');
    expect(chatSystem).toContain('<how-to-respond>\nUse British spelling.\n</how-to-respond>');
    expect(chatSystem).toContain('Response style: concise.');

    const code = harness({ personalization: { ...personalization, style: 'learning' }, script: [{ text: 'ok' }] });
    code.session.send('hello');
    await code.session.idle();
    expect(code.provider.requests[0]!.system).toContain('Use British spelling.');
    expect(code.provider.requests[0]!.system).toContain('Response style: learning.');

    const incognito = harness({ kind: 'chat', incognito: true, personalization, script: [{ text: 'ok' }] });
    incognito.session.send('hello');
    await incognito.session.idle();
    expect(incognito.provider.requests[0]!.system).not.toContain('data engineer');
    expect(incognito.provider.requests[0]!.system).not.toContain("The user's preferences");

    // Nothing set: no section at all.
    const plain = harness({ kind: 'chat', script: [{ text: 'ok' }] });
    plain.session.send('hello');
    await plain.session.idle();
    expect(plain.provider.requests[0]!.system).not.toContain("The user's preferences");
  });

  it('previews the exact system prompt and tools of the next turn without changing what turns send', async () => {
    const h = harness({ script: [{ text: 'one' }, { text: 'two' }] });
    const before = await h.session.promptPreview();
    expect(before.model).toBe('Fake Model via Fake Provider');
    h.session.send('first');
    await h.session.idle();
    const sent = h.provider.requests[0]!;
    expect(sent.system).toBe(before.system);
    expect(sent.tools.map((t) => t.name).sort()).toEqual([...before.tools].sort());
    const after = await h.session.promptPreview();
    expect(after.system).toBe(sent.system);
    h.session.send('second');
    await h.session.idle();
    expect(h.provider.requests[1]!.system).toBe(sent.system);
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
    expect(await generateTitle(provider, main, 'my websocket tests fail randomly', new AbortController().signal, { noTraining: true, zeroRetention: false })).toBe(
      'Debugging flaky websocket tests'
    );
    expect(provider.requests[0]!.tools).toEqual([]);
    expect(provider.requests[0]!.privacy).toEqual({ noTraining: true, zeroRetention: false });
  });
});

describe('shell commands from the message box', () => {
  it('runs a "!" command in the session shell without a model turn, and the next turn sees its output', async () => {
    const h = harness({ script: [{ text: 'It printed the marker.' }] });
    h.session.runShell('echo graft-shell-marker');
    await h.session.idle();
    const ran = h.store.listMessages('session-1').find((m) => m.meta.kind === 'shell');
    expect(ran?.role).toBe('user');
    expect(ran?.meta.shell).toMatchObject({ command: 'echo graft-shell-marker', exitCode: 0, timedOut: false, interrupted: false });
    expect(ran?.meta.shell?.output).toContain('graft-shell-marker');
    expect(h.provider.requests).toHaveLength(0);
    expect(h.events.map((e) => e.type)).toEqual(expect.arrayContaining(['turn-start', 'message', 'turn-end']));
    expect(h.session.summary.status).toBe('idle');

    h.session.send('what did it print?');
    await h.session.idle();
    const sent = JSON.stringify(h.provider.requests[0]!.messages);
    expect(sent).toContain('<user-shell-command');
    expect(sent).toContain('graft-shell-marker');
    expect(sent).toContain('what did it print?');
  });

  it('refuses in chats, without a command, and while a turn is running', async () => {
    const chat = harness({ kind: 'chat', script: [] });
    expect(() => chat.session.runShell('echo hi')).toThrow(/code sessions/);
    const h = harness({ script: [{ text: Array.from({ length: 40 }, (_, i) => `word${i}`).join(' '), chunkDelayMs: 15 }] });
    expect(() => h.session.runShell('   ')).toThrow(/command after the !/);
    h.session.send('start working');
    await h.waitFor((e) => e.type === 'assistant-delta');
    expect(() => h.session.runShell('echo hi')).toThrow(/Graft is working/);
    await h.session.idle();
    expect(h.store.listMessages('session-1').some((m) => m.meta.kind === 'shell')).toBe(false);
  });
});

describe('prompt commands', () => {
  it('expands /commit, /pr, /security-review, /explain and /test into prepared prompts that show as typed', async () => {
    const h = harness({ script: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }, { text: 'e' }] });
    for (const typed of ['/commit fix the login typo', '/pr', '/security-review auth', '/explain the session queue', '/test']) {
      h.session.send(typed);
      await h.session.idle();
    }
    const sent = h.provider.requests.map((r) => JSON.stringify(r.messages.at(-1)));
    expect(sent[0]).toContain('Commit the current changes.');
    expect(sent[0]).toContain('Notes for the message: fix the login typo');
    expect(sent[1]).toContain('gh pr create');
    expect(sent[2]).toContain('security review');
    expect(sent[2]).toContain('Focus especially on: auth');
    expect(sent[3]).toContain('Explain how the session queue works.');
    expect(sent[4]).toContain('never skip, delete or weaken a test');
    const typed = h.store.listMessages('session-1').filter((m) => m.role === 'user').map((m) => m.meta.typed);
    expect(typed).toEqual(['/commit fix the login typo', '/pr', '/security-review auth', '/explain the session queue', '/test']);
  });

  it('lets a project command replace a prompt built-in, but never a session control', async () => {
    const h = harness({ script: [{ text: 'ok' }] });
    writeFile(h.projectDir, '.graft/commands/commit.md', 'Commit with a Conventional Commits message. $ARGUMENTS');
    writeFile(h.projectDir, '.graft/commands/clear.md', 'This must never replace /clear.');
    const { listCommands } = await import('../../src/main/agent/slashCommands');
    const listed = listCommands(h.home, h.projectDir);
    expect(listed.filter((c) => c.name === 'commit')).toEqual([expect.objectContaining({ source: 'project' })]);
    expect(listed.filter((c) => c.name === 'clear')).toEqual([expect.objectContaining({ source: 'builtin' })]);
    h.session.send('/commit now');
    await h.session.idle();
    expect(JSON.stringify(h.provider.requests[0]!.messages.at(-1))).toContain('Conventional Commits message. now');
  });

  it('answers UI-only commands that reach the session instead of sending them to the model', async () => {
    const h = harness({ script: [] });
    h.session.send('/export notes.md');
    await h.session.idle();
    expect(h.provider.requests).toHaveLength(0);
    expect(texts(h).at(-1)).toMatch(/opens in the app/);
  });
});
