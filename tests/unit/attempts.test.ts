import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AttemptSet } from '../../src/shared/schemas/attempts';
import { addUsage, EMPTY_USAGE } from '../../src/shared/schemas/common';
import { textOf } from '../../src/shared/schemas/messages';
import { attemptTools } from '../../src/main/agent/attemptAgent';
import { insideGitRepo, linkDependencies, splitPatch } from '../../src/main/agent/attempts';
import { AgentWorkspaces, parseNumstat, unlinkLink } from '../../src/main/agent/workspaces';
import { openDatabase, type Db } from '../../src/main/db/database';
import { CheckpointService } from '../../src/main/git/checkpoints';
import type { StreamRequest } from '../../src/main/providers/types';
import { fakeModel, type FakeStep } from '../support/fakeProvider';
import { gitSync, makeRepo } from '../support/gitRepo';
import { makeHarness, type Harness, type HarnessOptions } from '../support/sessionHarness';
import { makeTempDir, removeDir, writeFile } from '../support/tmp';

const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) removeDir(dir);
});

const TWO = fakeModel({ ref: { providerId: 'fake', modelId: 'fake-two' }, label: 'Fake Two' });
const ONE = fakeModel();

/** Private checkouts kept in a folder of the test's own. */
function workspaces(): { manager: AgentWorkspaces; root: string } {
  const root = makeTempDir();
  dirs.push(root);
  const db = openDatabase(path.join(root, 'graft.db'));
  dbs.push(db);
  return { manager: new AgentWorkspaces(new CheckpointService(db, path.join(root, 'shadows')), path.join(root, 'writers')), root: path.join(root, 'writers') };
}

/** Which attempt a request is from, read from its prompt; null for the session's own agent. */
const attemptOf = (request: StreamRequest): number | null => {
  const found = /# Attempt (\d) of \d/.exec(request.system)?.[1];
  return found === undefined ? null : Number(found);
};
const stepsDone = (request: StreamRequest): number => request.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result').length;

/** Each attempt writes result.txt with its own words, reads it `reads` times, then reports. */
function writers(reads = 0, content = (n: number): string => `from attempt ${String(n)}\n`): FakeStep[] {
  const step: FakeStep = (request) => {
    const n = attemptOf(request);
    if (n === null) return { text: 'The session itself answered.' };
    const done = stepsDone(request);
    if (done === 0) return { toolCalls: [{ name: 'Write', input: { file_path: 'result.txt', content: content(n) } }] };
    if (done <= reads) return { toolCalls: [{ name: 'Read', input: { file_path: 'result.txt' } }] };
    return { text: `Attempt ${String(n)} wrote result.txt.` };
  };
  return Array.from({ length: 30 }, () => step);
}

function start(options: Partial<HarnessOptions> = {}): Harness & { manager: AgentWorkspaces; writersRoot: string } {
  const project = makeRepo({ 'README.md': '# demo\n' });
  dirs.push(project);
  const { manager, root } = workspaces();
  const h = makeHarness({ projectDir: project, mode: 'auto-edit', models: [ONE, TWO], workspaces: manager, script: writers(), ...options });
  dirs.push(h.home);
  return Object.assign(h, { manager, writersRoot: root });
}

const setOf = (h: Harness): AttemptSet => {
  const set = h.store.listMessages('session-1').find((m) => m.meta.attempts)?.meta.attempts;
  if (!set) throw new Error('no attempts card');
  return set;
};

async function sendAsTwo(h: Harness, text = 'Write result.txt'): Promise<AttemptSet> {
  h.session.send(text, [], [], [ONE.ref, TWO.ref]);
  await h.session.idle();
  return setOf(h);
}

const checkoutOf = (h: Harness & { manager: AgentWorkspaces }, set: AttemptSet, index: number): string => {
  const id = set.attempts[index - 1]?.workspaceId;
  const lease = id ? h.manager.load(id) : null;
  if (!lease) throw new Error(`no checkout for attempt ${String(index)}`);
  return lease.cwd;
};

describe('a message sent as attempts', () => {
  it('runs each attempt in its own checkout, leaves the folder alone, and waits with what each changed, its checks and its usage', async () => {
    const h = start();
    // The checks need the project's dependencies, which a checkout gets only as a link while they run.
    writeFile(h.projectDir, 'node_modules/dep/index.js', 'module.exports = 1;\n');
    writeFile(h.projectDir, '.gitignore', 'node_modules/\n.graft/\n');
    writeFile(h.projectDir, '.graft/settings.local.json', JSON.stringify({ checks: { commands: ['node -e "require(\'fs\').accessSync(\'node_modules/dep/index.js\')"'], fix: false, timeoutSec: 60 } }));
    const set = await sendAsTwo(h);

    expect(set.status).toBe('open');
    expect(set.attempts.map((a) => [a.index, a.model.label, a.status])).toEqual([
      [1, 'Fake Model', 'candidate'],
      [2, 'Fake Two', 'candidate']
    ]);
    for (const attempt of set.attempts) {
      expect(attempt.files).toEqual([{ path: 'result.txt', added: 1, removed: 0, binary: false }]);
      expect(attempt.checks?.passed).toBe(true);
      expect(attempt.usage.inputTokens).toBeGreaterThan(0);
      expect(attempt.report).toBe(`Attempt ${String(attempt.index)} wrote result.txt.`);
    }
    // Nothing reached the folder; each checkout holds its own attempt, and the link the checks used is gone again.
    expect(fs.existsSync(path.join(h.projectDir, 'result.txt'))).toBe(false);
    for (const n of [1, 2]) {
      const checkout = checkoutOf(h, set, n);
      expect(fs.readFileSync(path.join(checkout, 'result.txt'), 'utf8')).toBe(`from attempt ${String(n)}\n`);
      expect(() => fs.lstatSync(path.join(checkout, 'node_modules'))).toThrow();
    }
    // Each attempt was told which it is, on its own model.
    const asked = h.provider.requests.filter((r) => attemptOf(r) !== null);
    expect(new Set(asked.map((r) => `${String(attemptOf(r))}:${r.model.ref.modelId}`))).toEqual(new Set(['1:fake-model', '2:fake-two']));
    // The session pays for its attempts: its totals are theirs together.
    const together = set.attempts.reduce((sum, a) => addUsage(sum, a.usage), EMPTY_USAGE);
    expect(h.store.getSummary('session-1').usage.totals).toEqual(together);
    // The card is shown and never sent; the user's message is the last thing the model would read.
    const card = h.store.listMessages('session-1').find((m) => m.meta.attempts);
    expect(card?.meta.kind).toBe('notice');
    expect(h.notifications.at(-1)).toEqual({ kind: 'finished', text: '2 of 2 attempts are ready to compare.' });
  });

  it('applies one attempt: the folder gets its content, every checkout and branch goes, and the conversation says what happened', async () => {
    const h = start();
    const set = await sendAsTwo(h);
    const checkouts = [checkoutOf(h, set, 1), checkoutOf(h, set, 2)];

    expect(await h.session.applyAttempt(set.id, 2)).toEqual({ files: ['result.txt'] });

    expect(fs.readFileSync(path.join(h.projectDir, 'result.txt'), 'utf8')).toBe('from attempt 2\n');
    for (const checkout of checkouts) expect(fs.existsSync(checkout)).toBe(false);
    expect(gitSync(h.projectDir, 'branch', '--list', 'graft/agent-*').trim()).toBe('');
    // The applied attempt's patch stays readable; the other's record is gone.
    expect(h.session.attemptDiff(set.id, 2).files.map((f) => f.path)).toEqual(['result.txt']);
    expect(() => h.session.attemptDiff(set.id, 1)).toThrow(/no changes to show/);
    const after = setOf(h);
    expect([after.status, after.applied, after.note]).toEqual(['applied', 2, null]);
    const said = h.store.listMessages('session-1').at(-1);
    expect(said?.role).toBe('assistant');
    expect(said?.meta.kind).toBeUndefined();
    expect(said?.content).toEqual([{ type: 'text', text: 'Applied attempt 2 of 2 (Fake Two) to the folder. It changed result.txt.\n\nIts report:\nAttempt 2 wrote result.txt.' }]);
    // Once is all: the same attempt or another can't be applied over it.
    await expect(h.session.applyAttempt(set.id, 1)).rejects.toMatchObject({ code: 'attempts_applied' });
  });

  it('holds a message sent while an attempt is applied, so the agent reads what was applied before it', async () => {
    const h = start();
    const set = await sendAsTwo(h);
    const applying = h.session.applyAttempt(set.id, 1);
    expect(h.session.send('What changed?')).toEqual({ queued: true });
    await applying;
    await h.session.idle();

    expect(h.store.listMessages('session-1').slice(-3).map((m) => [m.role, textOf(m.content)])).toEqual([
      ['assistant', 'Applied attempt 1 of 2 (Fake Model) to the folder. It changed result.txt.\n\nIts report:\nAttempt 1 wrote result.txt.'],
      ['user', 'What changed?'],
      ['assistant', 'The session itself answered.']
    ]);
    const asked = JSON.stringify(h.provider.requests.at(-1)?.messages);
    expect(asked.indexOf('Applied attempt 1 of 2')).toBeGreaterThan(-1);
    expect(asked.indexOf('Applied attempt 1 of 2')).toBeLessThan(asked.indexOf('What changed?'));
  });

  it('refuses to apply an attempt when a file it changed differs in the folder since the attempts started, and changes nothing', async () => {
    const h = start();
    const set = await sendAsTwo(h);
    writeFile(h.projectDir, 'result.txt', 'the user wrote this\n');

    await expect(h.session.applyAttempt(set.id, 1)).rejects.toMatchObject({
      code: 'attempt_conflict',
      message: "Attempt 1 wasn't applied: result.txt changed in the folder since the attempts started. Nothing was changed. Undo those changes and apply again, or discard the attempts and send the message again."
    });
    expect(fs.readFileSync(path.join(h.projectDir, 'result.txt'), 'utf8')).toBe('the user wrote this\n');
    expect(setOf(h).status).toBe('open');
    expect(fs.existsSync(checkoutOf(h, set, 1))).toBe(true);
  });

  it('discards every checkout and leaves the folder as it was', async () => {
    const h = start();
    const set = await sendAsTwo(h);
    const checkouts = [checkoutOf(h, set, 1), checkoutOf(h, set, 2)];

    await h.session.discardAttempts(set.id);

    for (const checkout of checkouts) expect(fs.existsSync(checkout)).toBe(false);
    expect(fs.readdirSync(h.writersRoot).filter((name) => name.endsWith('.json') || name.endsWith('.patch'))).toEqual([]);
    expect(fs.existsSync(path.join(h.projectDir, 'result.txt'))).toBe(false);
    expect(setOf(h).status).toBe('discarded');
    expect(h.store.listMessages('session-1').at(-1)?.content).toEqual([{ type: 'text', text: 'Discarded the 2 attempts at this message. The folder is as it was.' }]);
    await expect(h.session.applyAttempt(set.id, 1)).rejects.toMatchObject({ code: 'attempts_discarded' });
  });

  it("counts every attempt against the turn's limits together", async () => {
    // Three requests of 120 tokens each: one attempt alone stays under 400, two together do not.
    const h = start({ script: writers(1), turnBudget: { tokens: 400 } });
    const set = await sendAsTwo(h);

    const stopped = set.attempts.filter((a) => a.status === 'stopped');
    expect(stopped.length).toBeGreaterThan(0);
    for (const attempt of stopped) expect(attempt.error).toMatch(/^Stopped: the turn reached a limit before this attempt finished\. Paused after about/);
    expect(h.events.some((e) => e.type === 'notice' && e.level === 'warning' && /past the limit of 400/.test(e.text))).toBe(true);
    const together = set.attempts.reduce((sum, a) => addUsage(sum, a.usage), EMPTY_USAGE);
    expect(h.store.getSummary('session-1').usage.totals).toEqual(together);
  });

  it('stops one attempt while the other goes on', async () => {
    const step: FakeStep = (request) => {
      const n = attemptOf(request);
      if (n === 1) return { text: Array.from({ length: 400 }, (_, i) => `word${String(i)} `).join(''), chunkDelayMs: 20 };
      return stepsDone(request) === 0 ? { toolCalls: [{ name: 'Write', input: { file_path: 'result.txt', content: 'two\n' } }] } : { text: 'Attempt 2 is done.' };
    };
    const h = start({ script: Array.from({ length: 10 }, () => step) });
    h.session.send('Write result.txt', [], [], [ONE.ref, TWO.ref]);
    await h.waitFor((e) => e.type === 'message' && e.message.meta.attempts?.attempts[0]?.status === 'running');
    const id = setOf(h).id;
    // The first attempt's reply is still arriving.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.session.stopAttempt(id, 1)).toBe(true);
    await h.session.idle();

    const set = setOf(h);
    expect(set.attempts.map((a) => [a.status, a.error])).toEqual([
      ['stopped', 'Stopped.'],
      ['candidate', null]
    ]);
    expect(h.session.stopAttempt(id, 2)).toBe(false);
  });

  it('after Graft stopped mid-run, says so on the card and keeps the finished attempts applicable', async () => {
    const h = start();
    const set = await sendAsTwo(h);
    // As the store would hold it had Graft stopped while the second attempt was still running.
    const cut: AttemptSet = { ...set, status: 'running', attempts: set.attempts.map((a) => (a.index === 2 ? { ...a, status: 'running', endedAt: null } : a)) };
    h.store.updateMessageMeta(set.id, { attempts: cut });
    await h.session.dispose();
    h.reopen();

    const recovered = setOf(h);
    expect(recovered.status).toBe('open');
    expect(recovered.note).toBe('Graft stopped while these attempts were running.');
    expect(recovered.attempts.map((a) => a.status)).toEqual(['candidate', 'stopped']);
    expect(recovered.attempts[1]?.error).toMatch(/^Graft stopped while this attempt was running\./);
    await h.session.applyAttempt(set.id, 1);
    expect(fs.readFileSync(path.join(h.projectDir, 'result.txt'), 'utf8')).toBe('from attempt 1\n');
  });

  it('takes the checkouts of attempts a rewind removed', async () => {
    const h = start();
    const set = await sendAsTwo(h);
    const checkouts = [checkoutOf(h, set, 1), checkoutOf(h, set, 2)];
    const sent = h.store.listMessages('session-1').find((m) => m.id === set.messageId)!;

    h.session.truncateFrom(sent.seq);
    // The removal goes on after the rewind returns: the checkouts, their branches, then their records.
    const gone = (): boolean =>
      checkouts.every((c) => !fs.existsSync(c)) &&
      gitSync(h.projectDir, 'branch', '--list', 'graft/agent-*').trim() === '' &&
      fs.readdirSync(h.writersRoot).every((name) => !name.endsWith('.json'));
    await expect.poll(gone, { timeout: 10_000 }).toBe(true);
  });

  it('is refused where it cannot work, with a sentence that says why', () => {
    const plain = makeTempDir();
    dirs.push(plain);
    const outside = makeHarness({ projectDir: plain, script: [], workspaces: workspaces().manager });
    dirs.push(outside.home);
    expect(() => outside.session.send('Go', [], [], [ONE.ref, TWO.ref])).toThrow(/Git repository/);

    const h = start({ mode: 'plan' });
    expect(() => h.session.send('Go', [], [], [ONE.ref, TWO.ref])).toThrow(/Leave Plan mode first/);
    h.session.setPermissionMode('auto-edit');
    expect(() => h.session.send('/review', [], [], [ONE.ref, TWO.ref])).toThrow(/Commands run once/);
  });
});

describe('the parts of attempts', () => {
  it('removes a checkout without following a link in it into the project', async () => {
    const project = makeRepo({ 'a.txt': 'a\n', '.gitignore': 'node_modules/\n' });
    dirs.push(project);
    writeFile(project, 'node_modules/dep/index.js', 'kept\n');
    const { manager } = workspaces();
    const lease = await manager.create(project, new AbortController().signal);
    expect(linkDependencies([[project, lease.cwd]])).toEqual([path.join(lease.cwd, 'node_modules')]);
    expect(fs.readFileSync(path.join(lease.cwd, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('kept\n');
    // A link made some other way, deeper in the checkout, is not followed either.
    fs.mkdirSync(path.join(lease.cwd, 'deep'));
    fs.symlinkSync(project, path.join(lease.cwd, 'deep', 'project'), process.platform === 'win32' ? 'junction' : 'dir');

    await manager.remove(lease);

    expect(fs.existsSync(lease.root)).toBe(false);
    expect(fs.readFileSync(path.join(project, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('kept\n');
    expect(fs.readFileSync(path.join(project, 'a.txt'), 'utf8')).toBe('a\n');
    expect(manager.load(lease.id)).toBeNull();
  });

  it('leaves a real folder where a link was expected, and links nothing over one', () => {
    const project = makeTempDir();
    const checkout = makeTempDir();
    dirs.push(project, checkout);
    writeFile(project, 'node_modules/x.js', '');
    writeFile(checkout, 'node_modules/own.js', 'own');
    expect(linkDependencies([[project, checkout]])).toEqual([]);
    unlinkLink(path.join(checkout, 'node_modules'));
    expect(fs.readFileSync(path.join(checkout, 'node_modules', 'own.js'), 'utf8')).toBe('own');
  });

  it('splits a patch file by file, leaving out the bytes of a binary file and what is past the limit', () => {
    const text = [
      'diff --git a/src/a b.ts b/src/a b.ts',
      'index 1..2 100644',
      '--- a/src/a b.ts',
      '+++ b/src/a b.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/logo.png b/logo.png',
      'new file mode 100644',
      'GIT binary patch',
      'literal 3',
      'zcmZ',
      'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
      '--- /dev/null',
      '+++ "b/caf\\303\\251.txt"',
      '@@ -0,0 +1 @@',
      '+x',
      ''
    ].join('\n');
    const all = splitPatch(text);
    expect(all.files.map((f) => [f.path, f.binary, f.patch.length > 0])).toEqual([
      ['src/a b.ts', false, true],
      ['logo.png', true, false],
      ['café.txt', false, true]
    ]);
    expect(all.truncated).toBe(false);
    const cut = splitPatch(text, 120);
    expect(cut.files.map((f) => f.patch.length > 0)).toEqual([true, false, false]);
    expect(cut.truncated).toBe(true);
  });

  it('reads line counts, binary files included', () => {
    expect(parseNumstat('3\t1\tsrc/a b.ts\u0000-\t-\tlogo.png\u0000')).toEqual([
      { path: 'src/a b.ts', added: 3, removed: 1, binary: false },
      { path: 'logo.png', added: 0, removed: 0, binary: true }
    ]);
  });

  it("gives an attempt the session's tools except those that delegate, ask, plan or drive the one browser and screen", () => {
    expect(attemptTools(['Read', 'Edit', 'Write', 'Shell', 'Task', 'RunAgents', 'AskUserQuestion', 'ExitPlanMode', 'TodoWrite', 'Browser', 'Computer', 'ToolSearch', 'WebFetch'])).toEqual([
      'Read',
      'Edit',
      'Write',
      'Shell',
      'WebFetch'
    ]);
  });

  it('knows a folder inside a Git repository from one outside', () => {
    const repo = makeRepo();
    const plain = makeTempDir();
    dirs.push(repo, plain);
    fs.mkdirSync(path.join(repo, 'packages', 'app'), { recursive: true });
    expect(insideGitRepo(path.join(repo, 'packages', 'app'))).toBe(true);
    expect(insideGitRepo(plain)).toBe(false);
  });
});
