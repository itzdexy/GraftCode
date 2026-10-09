import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentRun } from '../../src/shared/schemas/agentRuns';
import type { AgentEvent } from '../../src/shared/schemas/agentEvents';
import { textOf } from '../../src/shared/schemas/messages';
import { sourcesOf } from '../../src/shared/sources';
import { ProviderError } from '../../src/main/providers/errors';
import type { StreamRequest } from '../../src/main/providers/types';
import { fakeModel, type FakeFailure, type FakeReply, type FakeStep } from '../support/fakeProvider';
import { makeHarness, type Harness, type HarnessOptions } from '../support/sessionHarness';

/** The task an agent of a group was given, read from its system prompt; null for the main agent. */
function taskOf(request: StreamRequest): string | null {
  return /Your task: "([^"]+)"/.exec(request.system)?.[1] ?? null;
}

/** Everything the model was sent in its messages, as text. */
function sentText(request: StreamRequest): string {
  return request.messages.map((m) => m.content.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? textOf(b.content) : '')).join('\n')).join('\n');
}

type Answer = FakeReply | FakeFailure;

/**
 * A scripted model for a session that runs a group: the main agent calls
 * RunAgents once and then wraps up; each agent of the group is answered by
 * `agent`, whatever order they run in.
 */
function script(group: unknown[], agent: (task: string, request: StreamRequest) => Answer, steps = 40): FakeStep[] {
  const main = (request: StreamRequest): Answer =>
    request.messages.some((m) => m.content.some((b) => b.type === 'tool_result'))
      ? { text: 'The group is done.' }
      : { toolCalls: [{ id: 'group-1', name: 'RunAgents', input: { goal: 'Ship the feature', agents: group } }] };
  const step: FakeStep = (request) => {
    const task = taskOf(request);
    return task === null ? main(request) : agent(task, request);
  };
  return Array.from({ length: steps }, () => step);
}

/** A session whose model runs `group` when asked. `agents` stays the harness option for Settings → Models → Agents. */
function start(options: Omit<HarnessOptions, 'script'> & { group: unknown[]; agent: (task: string, request: StreamRequest) => Answer }): Harness {
  const { group, agent, ...rest } = options;
  return makeHarness({ mode: 'bypass', bypassEnabled: true, ...rest, script: script(group, agent) });
}

const runsOf = (h: Harness): Record<string, AgentRun> => Object.fromEntries(h.store.listAgentRuns('session-1').map((r) => [r.nodeId, r]));

async function run(options: Parameters<typeof start>[0]): Promise<Harness & { runs: Record<string, AgentRun> }> {
  const h = start(options);
  h.session.send('Build the feature with a group of agents.');
  await h.session.idle();
  return Object.assign(h, { runs: runsOf(h) });
}

const explorer = (id: string, task: string, extra: object = {}): object => ({ id, role: 'explorer', task, prompt: `Look into ${task}.`, ...extra });

describe('a group of agents', () => {
  it('runs independent agents side by side, hands their reports to what depends on them, and returns every report', async () => {
    let builderSaw = '';
    const h = await run({
      group: [explorer('a', 'Map the routes'), explorer('b', 'Map the tests'), { id: 'build', role: 'implementer', task: 'Add the endpoint', prompt: 'Add it.', depends_on: ['a', 'b'] }],
      agent: (task, request) => {
        if (task === 'Add the endpoint') {
          builderSaw = sentText(request);
          return { text: 'Added the endpoint in src/routes.ts:12.' };
        }
        return { text: task === 'Map the routes' ? 'Routes live in src/routes.ts.' : 'Tests live in test/routes.test.ts.', chunkDelayMs: 25 };
      }
    });
    expect(Object.values(h.runs).map((r) => [r.nodeId, r.status])).toEqual([
      ['a', 'done'],
      ['b', 'done'],
      ['build', 'done']
    ]);
    const { a, b, build } = h.runs;
    // The two explorers overlapped in time; the builder started after both had ended.
    expect(a!.startedAt!).toBeLessThan(b!.endedAt!);
    expect(b!.startedAt!).toBeLessThan(a!.endedAt!);
    expect(build!.startedAt!).toBeGreaterThanOrEqual(Math.max(a!.endedAt!, b!.endedAt!));
    expect(builderSaw).toContain('Routes live in src/routes.ts.');
    expect(builderSaw).toContain('Tests live in test/routes.test.ts.');
    expect(build!.result).toBe('Added the endpoint in src/routes.ts:12.');
    const toolResult = h.store
      .listMessages('session-1')
      .flatMap((m) => m.content)
      .find((b) => b.type === 'tool_result' && b.toolUseId === 'group-1');
    expect(toolResult?.type === 'tool_result' && textOf(toolResult.content)).toContain('Added the endpoint in src/routes.ts:12.');
    expect(toolResult?.type === 'tool_result' && toolResult.display).toMatchObject({ kind: 'agents', goal: 'Ship the feature' });
  });

  it('gives each agent only the tools of its role, and a fresh context', async () => {
    const tools: Record<string, string[]> = {};
    const sent: Record<string, string> = {};
    await run({
      group: [explorer('look', 'Read the code'), { id: 'fix', role: 'implementer', task: 'Fix the bug', prompt: 'Fix it.' }],
      agent: (task, request) => {
        tools[task] = request.tools.map((t) => t.name);
        sent[task] = sentText(request);
        return { text: 'ok' };
      }
    });
    expect(tools['Read the code']).toEqual(['Glob', 'Grep', 'Read', 'SemanticCode', 'Symbols', 'WebFetch']);
    expect(tools['Fix the bug']).toEqual(expect.arrayContaining(['Edit', 'Write', 'Shell']));
    expect(tools['Fix the bug']).not.toContain('RunAgents');
    expect(tools['Fix the bug']).not.toContain('Task');
    expect(sent['Read the code']).not.toContain('Build the feature with a group of agents.');
  });

  it('records what every agent did: its model and why, tools, files, tokens and timeline', async () => {
    const h = await run({
      group: [{ id: 'fix', role: 'implementer', task: 'Write the note', prompt: 'Write it.' }],
      agent: (_task, request) =>
        request.messages.length > 1
          ? { text: 'Wrote note.txt.', usage: { inputTokens: 300, outputTokens: 40 } }
          : { toolCalls: [{ name: 'Write', input: { file_path: 'note.txt', content: 'hello\n' } }], usage: { inputTokens: 200, outputTokens: 30 } }
    });
    const fix = h.runs.fix!;
    expect(fs.readFileSync(path.join(h.projectDir, 'note.txt'), 'utf8')).toBe('hello\n');
    expect(fix).toMatchObject({ status: 'done', roleLabel: 'Implementer', toolCalls: 1, toolsUsed: { Write: 1 }, exclusive: true, attempt: 1 });
    expect(fix.model).toMatchObject({ modelId: 'fake-model', label: 'Fake Model' });
    expect(fix.routing.join(' ')).toMatch(/session/i);
    expect(fix.filesChanged.map((f) => path.basename(f))).toEqual(['note.txt']);
    expect(fix.usage).toMatchObject({ inputTokens: 500, outputTokens: 70 });
    expect(fix.timeline.map((e) => e.kind)).toEqual(['start', 'tool', 'end']);
    // The session's own totals include what its agents spent.
    expect(h.session.summary.usage.totals.inputTokens).toBeGreaterThanOrEqual(500);
  });

  it('tells the interface about every change, so the graph is live', async () => {
    const h = await run({ group: [explorer('a', 'Look around')], agent: () => ({ text: 'Looked.' }) });
    const events = h.events.filter((e): e is Extract<AgentEvent, { type: 'agent-run' }> => e.type === 'agent-run');
    const statuses = events.map((e) => e.run.status);
    expect(statuses[0]).toBe('queued');
    expect(statuses).toContain('running');
    expect(statuses.at(-1)).toBe('done');
    expect(h.session.detail().agentRuns).toHaveLength(1);
    // Each change is numbered, so a view that hears two of them out of order keeps the later one.
    const revs = events.map((e) => e.run.rev);
    expect(revs[0]).toBe(0);
    expect(revs).toEqual([...revs].sort((x, y) => x - y));
    expect(new Set(revs).size).toBe(revs.length);
  });

  it('tries an agent again after a provider failure, and skips what depended on one that keeps failing', async () => {
    const h = await run({
      group: [explorer('bad', 'Break'), explorer('after', 'Use the broken one', { depends_on: ['bad'] }), explorer('fine', 'Carry on')],
      agent: (task) => (task === 'Break' ? { error: new ProviderError('overloaded', 'The provider is overloaded (529).') } : { text: 'Fine.' })
    });
    expect(h.runs.bad).toMatchObject({ status: 'failed', attempt: 2 });
    expect(h.runs.bad!.retries).toHaveLength(1);
    expect(h.runs.bad!.error).toMatch(/overloaded/);
    expect(h.runs.after).toMatchObject({ status: 'skipped' });
    expect(h.runs.after!.error).toMatch(/bad/);
    expect(h.runs.fine).toMatchObject({ status: 'done' });
  });

  it('counts work as done only when its check passes, sending a failed check back to the agent', async () => {
    const check = `node -e "process.exit(require('fs').existsSync('ok.txt') ? 0 : 1)"`;
    const h = await run({
      group: [{ id: 'fix', role: 'implementer', task: 'Make the check pass', prompt: 'Do it.', verify: check }],
      agent: (_task, request) => {
        if (!sentText(request).includes('failed (round')) return { text: 'Done, I think.' };
        const last = request.messages.at(-1);
        return last?.content.some((b) => b.type === 'tool_result') ? { text: 'Fixed for real.' } : { toolCalls: [{ name: 'Write', input: { file_path: 'ok.txt', content: 'ok\n' } }] };
      }
    });
    expect(h.runs.fix).toMatchObject({ status: 'done', result: 'Fixed for real.' });
    expect(h.runs.fix!.verify).toMatchObject({ command: check, passed: true, rounds: 2 });
    expect(h.runs.fix!.timeline.filter((e) => e.kind === 'verify').map((e) => e.text.startsWith('Check passed'))).toEqual([false, true]);
  });

  it('fails an agent whose check never passes, with the output that shows why', async () => {
    const h = await run({
      group: [{ id: 'fix', role: 'implementer', task: 'Never passes', prompt: 'Try.', verify: `node -e "console.log('still broken'); process.exit(3)"` }],
      agent: () => ({ text: 'It should work now.' })
    });
    expect(h.runs.fix).toMatchObject({ status: 'failed' });
    expect(h.runs.fix!.error).toMatch(/still fails after 3 rounds/);
    expect(h.runs.fix!.error).toContain('still broken');
    expect(h.runs.fix!.verify).toMatchObject({ passed: false, rounds: 3 });
  });

  it('stops an agent that spends more than its token budget', async () => {
    const h = await run({
      agents: { tokenBudget: 10_000 },
      group: [explorer('greedy', 'Read everything'), explorer('modest', 'Read a little')],
      agent: (task) => (task === 'Read everything' ? { toolCalls: [{ name: 'Glob', input: { pattern: '**/*' } }], usage: { inputTokens: 25_000, outputTokens: 100 } } : { text: 'Read a little.' })
    });
    expect(h.runs.greedy).toMatchObject({ status: 'failed', attempt: 1 });
    expect(h.runs.greedy!.error).toMatch(/budget of 10,000 tokens/);
    expect(h.runs.modest).toMatchObject({ status: 'done' });
  });

  it('asks the user about one action at a time when agents working side by side both need approval', async () => {
    const h = start({
      mode: 'ask',
      bypassEnabled: false,
      group: [
        { id: 'r1', role: 'reviewer', task: 'Review one', prompt: 'Review.' },
        { id: 'r2', role: 'reviewer', task: 'Review two', prompt: 'Review.' }
      ],
      agent: (task, request) => (request.messages.length > 1 ? { text: `${task}: reviewed.` } : { toolCalls: [{ name: 'Shell', input: { command: `node -e "console.log('${task}')"` } }] })
    });
    h.session.send('Review with two agents.');
    const asked: string[] = [];
    for (let i = 0; i < 2; i++) {
      const event = await h.waitFor((e) => e.type === 'permission' && !asked.includes(e.request.id));
      if (event.type !== 'permission') throw new Error('expected a permission request');
      asked.push(event.request.id);
      expect(event.request.agentLabel).toMatch(/^Reviewer: Review (one|two)$/);
      // Only one request is ever on screen.
      expect(h.session.detail().pendingPermission?.id).toBe(event.request.id);
      h.session.respondPermission({ requestId: event.request.id, decision: 'allow-once' });
    }
    await h.session.idle();
    expect(Object.values(runsOf(h)).map((r) => r.status)).toEqual(['done', 'done']);
  });

  it('stops every agent when the turn is stopped, and none is left looking busy', async () => {
    const h = start({
      group: [explorer('slow', 'Take a while'), explorer('waiting', 'Wait for the slow one', { depends_on: ['slow'] })],
      agent: () => ({ text: 'word '.repeat(200), chunkDelayMs: 20 })
    });
    h.session.send('Start, then I will stop you.');
    await h.waitFor((e) => e.type === 'agent-run' && e.run.nodeId === 'slow' && e.run.status === 'running');
    h.session.interrupt();
    await h.session.idle();
    expect(Object.values(runsOf(h)).map((r) => r.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('stops one agent when asked, and lets the others finish and report', async () => {
    const h = start({
      group: [explorer('slow', 'Take a while'), explorer('quick', 'Be quick'), explorer('after', 'Use the slow one', { depends_on: ['slow'] })],
      agent: (task) => (task === 'Take a while' ? { text: 'word '.repeat(400), chunkDelayMs: 20 } : { text: 'Quick answer.' })
    });
    h.session.send('Start the group.');
    const running = await h.waitFor((e) => e.type === 'agent-run' && e.run.nodeId === 'slow' && e.run.status === 'running');
    const runId = running.type === 'agent-run' ? running.run.id : '';
    expect(h.session.stopAgent(runId)).toBe(true);
    await h.session.idle();
    const runs = runsOf(h);
    expect([runs.slow!.status, runs.quick!.status, runs.after!.status]).toEqual(['cancelled', 'done', 'skipped']);
    // The turn went on: the main agent got a report that says one was stopped.
    const toolResult = h.store
      .listMessages('session-1')
      .flatMap((m) => m.content)
      .find((b) => b.type === 'tool_result' && b.toolUseId === 'group-1');
    expect(toolResult?.type === 'tool_result' && textOf(toolResult.content)).toMatch(/1 finished, 1 skipped, 1 stopped/);
    expect(h.session.detail().summary.status).toBe('idle');
    // Nothing is left to stop afterwards.
    expect(h.session.stopAgent(runId)).toBe(false);
    expect(h.session.stopAgent('no-such-run')).toBe(false);
  });

  it('lets agents that own different files write side by side, each kept to its own paths', async () => {
    const steps: Record<string, number> = {};
    const denied: string[] = [];
    const h = await run({
      group: [
        { id: 'api', role: 'implementer', task: 'Write the API', prompt: 'Write it.', writes: ['src/api/**'] },
        { id: 'ui', role: 'implementer', task: 'Write the UI', prompt: 'Write it.', writes: ['src/ui/**', 'README.md'] },
        { id: 'anything', role: 'implementer', task: 'Tidy up', prompt: 'Tidy.', depends_on: ['api', 'ui'] }
      ],
      agent: (task, request) => {
        const step = (steps[task] = (steps[task] ?? 0) + 1);
        if (task === 'Write the API') {
          if (step === 1) return { text: 'Starting the API. '.repeat(6), toolCalls: [{ name: 'Write', input: { file_path: 'src/api/users.ts', content: 'export const users = [];\n' } }], chunkDelayMs: 15 };
          // Reaching into the other agent's files is refused, and the agent is told whose they are.
          if (step === 2) return { toolCalls: [{ name: 'Write', input: { file_path: 'src/ui/app.tsx', content: 'oops\n' } }] };
          denied.push(sentText(request));
          return { text: 'API written; the UI needs the same change.' };
        }
        if (task === 'Write the UI') {
          if (step === 1) return { text: 'Starting the UI. '.repeat(6), toolCalls: [{ name: 'Write', input: { file_path: 'src/ui/app.tsx', content: 'export const App = null;\n' } }], chunkDelayMs: 15 };
          if (step === 2) return { toolCalls: [{ name: 'Write', input: { file_path: 'README.md', content: '# Shop\n' } }] };
          return { text: 'UI written.' };
        }
        return step === 1 ? { toolCalls: [{ name: 'Write', input: { file_path: 'CHANGELOG.md', content: '- both\n' } }] } : { text: 'Tidied.' };
      }
    });
    const { api, ui, anything } = h.runs;
    expect([api!.status, ui!.status, anything!.status]).toEqual(['done', 'done', 'done']);
    // The two with paths overlapped in time; the one without paths had the project to itself, after them.
    expect(api!.startedAt!).toBeLessThan(ui!.endedAt!);
    expect(ui!.startedAt!).toBeLessThan(api!.endedAt!);
    expect(anything!.startedAt!).toBeGreaterThanOrEqual(Math.max(api!.endedAt!, ui!.endedAt!));
    expect([api!.exclusive, ui!.exclusive, anything!.exclusive]).toEqual([false, false, true]);
    expect(api!.writes).toEqual(['src/api/**']);
    expect(ui!.writes).toEqual(['src/ui/**', 'README.md']);
    expect(anything!.writes).toEqual([]);
    // Each wrote its own files; the UI file holds what the UI agent wrote, not what the API agent tried.
    const read = (file: string): string => fs.readFileSync(path.join(h.projectDir, file), 'utf8');
    expect(read('src/api/users.ts')).toBe('export const users = [];\n');
    expect(read('src/ui/app.tsx')).toBe('export const App = null;\n');
    expect(read('README.md')).toBe('# Shop\n');
    expect(read('CHANGELOG.md')).toBe('- both\n');
    expect(denied[0]).toMatch(/src\/ui\/app\.tsx/);
    expect(denied[0]).toMatch(/may change only/i);
    expect(denied[0]).toContain('src/api/**');
    expect(api!.filesChanged.map((f) => f.replace(/\\/g, '/'))).toEqual(['src/api/users.ts']);
  });

  it('tells an agent with paths of its own that others are working beside it, and which files are its to change', async () => {
    let system = '';
    await run({
      group: [{ id: 'api', role: 'implementer', task: 'Write the API', prompt: 'Write it.', writes: ['src/api/**'] }],
      agent: (_task, request) => {
        system = request.system;
        return { text: 'Done.' };
      }
    });
    expect(system).toMatch(/other agents/i);
    expect(system).toContain('src/api/**');
  });

  it('makes an agent read a file itself before changing it, whatever the main agent has read', async () => {
    const seen: string[] = [];
    const h = makeHarness({
      mode: 'bypass',
      bypassEnabled: true,
      script: (() => {
        let agentStep = 0;
        const step: FakeStep = (request) => {
          const task = taskOf(request);
          const results = request.messages.filter((m) => m.content.some((b) => b.type === 'tool_result')).length;
          if (task === null) {
            // The main agent reads the file, then hands the change to an agent.
            if (results === 0) return { toolCalls: [{ name: 'Read', input: { file_path: 'notes.txt' } }] };
            if (results === 1) return { toolCalls: [{ id: 'group-1', name: 'RunAgents', input: { goal: 'Fix the notes', agents: [{ id: 'fix', role: 'implementer', task: 'Fix the notes', prompt: 'Change hello to goodbye.' }] } }] };
            return { text: 'Done.' };
          }
          agentStep++;
          if (agentStep === 1) return { toolCalls: [{ name: 'Edit', input: { file_path: 'notes.txt', old_string: 'hello', new_string: 'goodbye' } }] };
          seen.push(sentText(request));
          if (agentStep === 2) return { toolCalls: [{ name: 'Read', input: { file_path: 'notes.txt' } }] };
          if (agentStep === 3) return { toolCalls: [{ name: 'Edit', input: { file_path: 'notes.txt', old_string: 'hello', new_string: 'goodbye' } }] };
          return { text: 'Changed it.' };
        };
        return Array.from({ length: 12 }, () => step);
      })()
    });
    fs.writeFileSync(path.join(h.projectDir, 'notes.txt'), 'hello\n');
    h.session.send('Fix the notes with an agent.');
    await h.session.idle();
    // Its first edit was refused: it had not read the file, though the main agent had.
    expect(seen[0]).toMatch(/Read notes\.txt before/);
    expect(fs.readFileSync(path.join(h.projectDir, 'notes.txt'), 'utf8')).toBe('goodbye\n');
    expect(runsOf(h).fix).toMatchObject({ status: 'done' });
  });

  it('refuses paths for a role that changes nothing, and paths that are not inside the project or name all of it', async () => {
    const reply = async (agents: unknown[]): Promise<string> => {
      const h = await run({ group: agents, agent: () => ({ text: 'never runs' }) });
      const result = h.store
        .listMessages('session-1')
        .flatMap((m) => m.content)
        .find((b) => b.type === 'tool_result' && b.toolUseId === 'group-1');
      expect(h.store.listAgentRuns('session-1')).toEqual([]);
      return result?.type === 'tool_result' ? textOf(result.content) : '';
    };
    expect(await reply([{ id: 'look', role: 'explorer', task: 'Look', prompt: 'Look.', writes: ['src/**'] }])).toMatch(/Explorer role.*changes no files/i);
    expect(await reply([{ id: 'fix', role: 'implementer', task: 'Fix', prompt: 'Fix.', writes: ['../elsewhere/**'] }])).toMatch(/inside the project/);
    expect(await reply([{ id: 'fix', role: 'implementer', task: 'Fix', prompt: 'Fix.', writes: ['**'] }])).toMatch(/whole project/);
  });

  it('refuses a group that cannot run, and tells the model why', async () => {
    const results: string[] = [];
    for (const group of [[explorer('a', 'One', { depends_on: ['b'] }), explorer('b', 'Two', { depends_on: ['a'] })], [{ id: 'x', role: 'wizard', task: 'Cast', prompt: 'Cast.' }]]) {
      const h = await run({ group, agent: () => ({ text: 'never runs' }) });
      const result = h.store
        .listMessages('session-1')
        .flatMap((m) => m.content)
        .find((b) => b.type === 'tool_result');
      results.push(result?.type === 'tool_result' && result.isError ? textOf(result.content) : 'not an error');
      expect(h.store.listAgentRuns('session-1')).toEqual([]);
    }
    expect(results[0]).toMatch(/loop/i);
    expect(results[1]).toMatch(/no role called "wizard"/);
  });

  it('runs an agent on the model assigned to its role, and says so in its record', async () => {
    const main = fakeModel();
    const small = fakeModel({ ref: { providerId: 'fake', modelId: 'small-model' }, label: 'Small Model' });
    const used: Record<string, string> = {};
    const h = await run({
      models: [main, small],
      agents: { roles: { reviewer: small.ref } },
      group: [{ id: 'rev', role: 'reviewer', task: 'Review the diff', prompt: 'Review.' }, explorer('look', 'Look around')],
      agent: (task, request) => {
        used[task] = request.model.ref.modelId;
        return { text: 'ok' };
      }
    });
    expect(used).toEqual({ 'Review the diff': 'small-model', 'Look around': 'fake-model' });
    expect(h.runs.rev!.model).toMatchObject({ modelId: 'small-model', label: 'Small Model' });
    expect(h.runs.rev!.routing.join(' ')).toMatch(/assigned/i);
  });

  it('takes a group away with the turn that started it when the session is rewound', async () => {
    const h = await run({ group: [explorer('a', 'Look around')], agent: () => ({ text: 'Looked.' }) });
    expect(h.store.listAgentRuns('session-1')).toHaveLength(1);
    const first = h.store.listMessages('session-1')[0]!;
    h.session.truncateFrom(first.seq);
    expect(h.store.listAgentRuns('session-1')).toEqual([]);
  });
});

describe('a group of researchers in a chat', () => {
  const web = { kind: 'chat' as const, webSearch: true, search: { active: () => 'brave' as const, search: () => Promise.resolve({ engine: 'brave' as const, results: [{ title: 'Found page', url: 'https://found.example/page', snippet: 's' }] }) } };

  it('gives every agent the two web tools and nothing else, whatever its role', async () => {
    const tools: Record<string, string[]> = {};
    const h = await run({
      ...web,
      group: [
        { id: 'r', role: 'researcher', task: 'Find the dates', prompt: 'Find them.' },
        { id: 'w', role: 'implementer', task: 'Write it up', prompt: 'Write.', depends_on: ['r'] }
      ],
      agent: (task, request) => ((tools[task] = request.tools.map((t) => t.name).sort()), { text: 'Done.' })
    });
    expect(tools).toEqual({ 'Find the dates': ['WebFetch', 'WebSearch'], 'Write it up': ['WebFetch', 'WebSearch'] });
    expect([h.runs.r!.status, h.runs.w!.status]).toEqual(['done', 'done']);
  });

  it('refuses a group that asks for a command to be run or files to be changed: a chat has no project', async () => {
    const asked: string[] = [];
    for (const extra of [{ verify: 'echo pwned > proof.txt' }, { writes: ['notes/**'] }]) {
      const h = await run({
        ...web,
        group: [{ id: 'r', role: 'researcher', task: 'Find the dates', prompt: 'Find them.', ...extra }],
        agent: (task) => (asked.push(task), { text: 'Done.' })
      });
      const result = h.store
        .listMessages('session-1')
        .flatMap((m) => m.content)
        .find((b) => b.type === 'tool_result' && b.toolUseId === 'group-1');
      expect(result?.type === 'tool_result' && result.isError).toBe(true);
      expect(result?.type === 'tool_result' && textOf(result.content)).toContain('In a chat, agents can search and read the web and nothing else: leave out verify and writes.');
      expect(Object.keys(h.runs)).toEqual([]);
    }
    expect(asked).toEqual([]);
  });

  it('hands back the pages its agents read and found, so the conversation knows them as its own', async () => {
    const h = await run({
      ...web,
      group: [{ id: 'r', role: 'researcher', task: 'Find the dates', prompt: 'Find them.' }],
      agent: (_task, request) =>
        request.messages.some((m) => m.content.some((b) => b.type === 'tool_result'))
          ? { text: 'It was 2024.' }
          : { toolCalls: [{ id: 'search-1', name: 'WebSearch', input: { query: 'when' } }] }
    });
    const messages = h.store.listMessages('session-1');
    const result = messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result' && b.toolUseId === 'group-1');
    expect(result?.type === 'tool_result' && result.display).toMatchObject({ kind: 'agents', sources: [{ url: 'https://found.example/page', title: 'Found page', state: 'found' }] });
    expect(sourcesOf(messages)).toEqual([{ url: 'https://found.example/page', title: 'Found page', state: 'found' }]);
  });
});
