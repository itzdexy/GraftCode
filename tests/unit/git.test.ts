import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/main/db/database';
import { CheckpointService } from '../../src/main/git/checkpoints';
import { computeDiffStats, DiffStatsCache } from '../../src/main/git/diffStats';
import {
  commit,
  fileDiff,
  listChanges,
  parseStatus,
  revertFiles,
  revertHunk,
  stageFiles,
  stageHunk,
  unstageFiles,
  unstageHunk
} from '../../src/main/git/changes';
import { compareUrl, createPullRequest, webUrlForRemote } from '../../src/main/git/pr';
import { currentBranch, defaultBranch, gitInfo, listBranches } from '../../src/main/git/repo';
import { createWorktree, removeWorktree, slugify, worktreeState } from '../../src/main/git/worktrees';
import { exists, gitSync, makeRepo, read } from '../support/gitRepo';
import { makeTempDir, removeDir, writeFile } from '../support/tmp';

const cleanup: string[] = [];
const track = (dir: string): string => {
  cleanup.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of cleanup.splice(0)) removeDir(dir);
});

describe('repository info and worktrees', () => {
  it('reports branch information', async () => {
    const repo = track(makeRepo());
    expect(await gitInfo(repo)).toMatchObject({ isRepo: true, branch: 'main' });
    expect(await defaultBranch(repo)).toBe('main');
    const notRepo = track(makeTempDir());
    expect(await gitInfo(notRepo)).toEqual({ isRepo: false, root: null, branch: null });
  });

  it('creates session worktrees on graft/ branches with unique names', async () => {
    const repo = track(makeRepo());
    const root = track(makeTempDir('graft worktrees (tmp) '));
    const first = await createWorktree({ repoDir: repo, worktreesRoot: root, slug: 'Fix the Login Bug!' });
    expect(first.branch).toBe('graft/fix-the-login-bug');
    expect(first.path).toBe(path.join(root, slugify(path.basename(repo), 60), 'fix-the-login-bug'));
    expect(exists(first.path, 'README.md')).toBe(true);
    expect(await currentBranch(first.path)).toBe('graft/fix-the-login-bug');
    const second = await createWorktree({ repoDir: repo, worktreesRoot: root, slug: 'fix the login bug' });
    expect(second.branch).toBe('graft/fix-the-login-bug-2');
    expect((await listBranches(repo)).map((b) => b.name)).toEqual(expect.arrayContaining(['main', 'graft/fix-the-login-bug', 'graft/fix-the-login-bug-2']));
  });

  it('refuses to remove a dirty worktree without force, and keeps unmerged branches', async () => {
    const repo = track(makeRepo());
    const root = track(makeTempDir('graft worktrees (tmp) '));
    const wt = await createWorktree({ repoDir: repo, worktreesRoot: root, slug: 'work' });
    writeFile(wt.path, 'new.txt', 'uncommitted');
    expect(await worktreeState(wt.path)).toEqual({ dirty: true, changedFiles: 0, untrackedFiles: 1 });
    await expect(removeWorktree({ repoDir: repo, worktreePath: wt.path, branch: wt.branch, force: false, deleteBranch: true })).rejects.toMatchObject({
      code: 'worktree_dirty'
    });
    expect(exists(wt.path, 'new.txt')).toBe(true);
    gitSync(wt.path, 'add', '-A');
    gitSync(wt.path, 'commit', '-q', '-m', 'work in progress');
    const removed = await removeWorktree({ repoDir: repo, worktreePath: wt.path, branch: wt.branch, force: false, deleteBranch: true });
    expect(removed.branchDeleted).toBe(false);
    expect(removed.branchKeptReason).toMatch(/not fully merged/);
    expect(fs.existsSync(wt.path)).toBe(false);
    const clean = await createWorktree({ repoDir: repo, worktreesRoot: root, slug: 'clean' });
    expect((await removeWorktree({ repoDir: repo, worktreePath: clean.path, branch: clean.branch, force: false, deleteBranch: true })).branchDeleted).toBe(true);
  });

  it('needs a first commit before creating worktrees', async () => {
    const dir = track(makeTempDir());
    gitSync(dir, 'init', '-q', '-b', 'main');
    await expect(createWorktree({ repoDir: dir, worktreesRoot: track(makeTempDir()), slug: 'x' })).rejects.toMatchObject({ code: 'worktree_no_commits' });
  });
});

/** Git 2.40 added --attr-source; older git (macOS ships 2.39) snapshots repositories in a private repository. */
const gitHasAttrSource = ((): boolean => {
  const match = /(\d+)\.(\d+)/.exec(gitSync(process.cwd(), '--version'));
  return match !== null && Number(match[1]) * 1000 + Number(match[2]) >= 2040;
})();

for (const { mode, attrSource } of [
  { mode: 'git 2.40 and later', attrSource: true },
  { mode: 'older git', attrSource: false }
]) {
  describe.skipIf(attrSource && !gitHasAttrSource)(`checkpoints and rewind (${mode})`, () => {
    let db: Db;
    let shadow: string;
    const newService = (): CheckpointService => new CheckpointService(db, shadow, undefined, () => Promise.resolve(attrSource));
    beforeEach(() => {
      db = openDatabase(':memory:');
      db.prepare("INSERT INTO sessions (id, kind, title, permission_mode, usage, created_at, updated_at) VALUES ('s1', 'code', 't', 'ask', '{}', 0, 0)").run();
      shadow = track(makeTempDir('graft shadow (tmp) '));
    });
    afterEach(() => db.close());

    it('snapshots without touching HEAD, branches or the staged index, and rewinds exactly', async () => {
      const repo = track(makeRepo({ 'a.txt': 'alpha\n', 'b.txt': 'bravo\n', '.gitignore': 'node_modules/\n' }));
      writeFile(repo, 'a.txt', 'alpha staged by the user\n');
      gitSync(repo, 'add', 'a.txt');
      writeFile(repo, 'user-notes.txt', 'mine\n');
      writeFile(repo, 'node_modules/pkg/index.js', 'ignored v1\n');
      const before = {
        head: gitSync(repo, 'rev-parse', 'HEAD'),
        staged: gitSync(repo, 'diff', '--cached'),
        status: gitSync(repo, 'status', '--porcelain'),
        branches: gitSync(repo, 'branch', '--list'),
        log: gitSync(repo, 'log', '--oneline')
      };
      const service = newService();
      const cp = await service.create('s1', repo, 'msg-1');
      expect(cp.ref).toMatch(/^refs\/graft\/checkpoints\/s1\//);
      // With older git the snapshot lives in the private repository, so the project gets no refs at all.
      expect(gitSync(repo, 'for-each-ref', 'refs/graft') === '').toBe(!attrSource);
      expect({
        head: gitSync(repo, 'rev-parse', 'HEAD'),
        staged: gitSync(repo, 'diff', '--cached'),
        status: gitSync(repo, 'status', '--porcelain'),
        branches: gitSync(repo, 'branch', '--list'),
        log: gitSync(repo, 'log', '--oneline')
      }).toEqual(before);

      // The agent then changes things.
      writeFile(repo, 'b.txt', 'bravo rewritten\n');
      fs.rmSync(path.join(repo, 'a.txt'));
      writeFile(repo, 'c.txt', 'created\n');
      writeFile(repo, 'deep/dir/d.txt', 'created deep\n');
      writeFile(repo, 'node_modules/pkg/index.js', 'ignored v2\n');

      const preview = await service.preview(cp.id);
      expect(preview.changes).toEqual([
        { path: 'a.txt', change: 'recreate' },
        { path: 'b.txt', change: 'restore' },
        { path: 'c.txt', change: 'delete' },
        { path: 'deep/dir/d.txt', change: 'delete' }
      ]);
      const result = await service.restore(cp.id);
      expect(result.changes).toEqual(preview.changes);
      expect(read(repo, 'a.txt')).toBe('alpha staged by the user\n');
      expect(read(repo, 'b.txt')).toBe('bravo\n');
      expect(exists(repo, 'c.txt')).toBe(false);
      expect(exists(repo, 'deep')).toBe(false);
      expect(read(repo, 'user-notes.txt')).toBe('mine\n');
      expect(read(repo, 'node_modules/pkg/index.js')).toBe('ignored v2\n');
      expect(gitSync(repo, 'diff', '--cached')).toBe(before.staged);
      expect(gitSync(repo, 'rev-parse', 'HEAD')).toBe(before.head);

      // The rewind itself can be undone from its safety checkpoint.
      await service.restore(result.safetyCheckpointId);
      expect(read(repo, 'c.txt')).toBe('created\n');
      expect(read(repo, 'b.txt')).toBe('bravo rewritten\n');
      expect(exists(repo, 'a.txt')).toBe(false);

      await service.deleteForSession('s1');
      expect(gitSync(repo, 'for-each-ref', 'refs/graft')).toBe('');
      expect(service.list('s1')).toEqual([]);
    });

    it('restores exact bytes despite autocrlf and eol attributes (regression: CRLF appeared on rewind)', async () => {
      const repo = track(makeRepo({ '.gitattributes': '* text=auto\n', 'win.txt': 'one\r\ntwo\r\n' }));
      gitSync(repo, 'config', 'core.autocrlf', 'true');
      writeFile(repo, 'unix.txt', 'agent\nwritten\n');
      writeFile(repo, 'win.txt', 'one\r\ntwo\r\nthree\r\n');
      const service = newService();
      const cp = await service.create('s1', repo, 'm');
      writeFile(repo, 'unix.txt', 'changed\n');
      writeFile(repo, 'win.txt', 'changed\r\n');
      await service.restore(cp.id);
      expect(fs.readFileSync(path.join(repo, 'unix.txt'))).toEqual(Buffer.from('agent\nwritten\n'));
      expect(fs.readFileSync(path.join(repo, 'win.txt'))).toEqual(Buffer.from('one\r\ntwo\r\nthree\r\n'));
    });

    it('works in folders that are not git repositories, without adding a .git folder', async () => {
      const dir = track(makeTempDir('plain project (tmp) '));
      writeFile(dir, 'index.html', '<h1>v1</h1>\n');
      writeFile(dir, 'node_modules/big/file.js', 'x\n');
      const service = newService();
      const cp = await service.create('s1', dir, 'msg-1');
      writeFile(dir, 'index.html', '<h1>v2</h1>\n');
      writeFile(dir, 'extra.css', 'body{}\n');
      fs.rmSync(path.join(dir, 'node_modules'), { recursive: true });
      expect((await service.preview(cp.id)).changes).toEqual([
        { path: 'extra.css', change: 'delete' },
        { path: 'index.html', change: 'restore' }
      ]);
      await service.restore(cp.id);
      expect(read(dir, 'index.html')).toBe('<h1>v1</h1>\n');
      expect(exists(dir, 'extra.css')).toBe(false);
      expect(exists(dir, '.git')).toBe(false);
    });

    it('skips what the project ignores, including its .git/info/exclude', async () => {
      const repo = track(makeRepo({ 'app.ts': 'v1\n', '.gitignore': 'logs/\n' }));
      fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), 'local-notes.txt\n');
      writeFile(repo, 'local-notes.txt', 'mine\n');
      writeFile(repo, 'logs/run.log', 'v1\n');
      const service = newService();
      const cp = await service.create('s1', repo, 'm');
      writeFile(repo, 'app.ts', 'v2\n');
      writeFile(repo, 'local-notes.txt', 'still mine\n');
      writeFile(repo, 'logs/run.log', 'v2\n');
      expect((await service.preview(cp.id)).changes).toEqual([{ path: 'app.ts', change: 'restore' }]);
      await service.restore(cp.id);
      expect(read(repo, 'app.ts')).toBe('v1\n');
      expect(read(repo, 'local-notes.txt')).toBe('still mine\n');
      expect(read(repo, 'logs/run.log')).toBe('v2\n');
    });

    it('checkpoints inside a session worktree independently of the main checkout', async () => {
      const repo = track(makeRepo({ 'app.ts': 'v1\n' }));
      const wt = await createWorktree({ repoDir: repo, worktreesRoot: track(makeTempDir()), slug: 'feature' });
      const service = newService();
      const cp = await service.create('s1', wt.path, 'm');
      writeFile(wt.path, 'app.ts', 'v2\n');
      writeFile(repo, 'app.ts', 'main checkout edit\n');
      await service.restore(cp.id);
      expect(read(wt.path, 'app.ts')).toBe('v1\n');
      expect(read(repo, 'app.ts')).toBe('main checkout edit\n');
    });
  });
}

describe('diff stats', () => {
  it('counts branch work against the merge-base, plus unstaged and untracked changes', async () => {
    const repo = track(makeRepo({ 'lib.ts': 'one\ntwo\nthree\n' }));
    gitSync(repo, 'switch', '-q', '-c', 'feature');
    writeFile(repo, 'lib.ts', 'one\nTWO\nthree\nfour\n');
    gitSync(repo, 'commit', '-q', '-am', 'change lib');
    writeFile(repo, 'lib.ts', 'one\nTWO\nthree\nfour\nfive\n');
    writeFile(repo, 'new.ts', 'a\nb\n');
    const stats = await computeDiffStats(repo);
    expect(stats).toMatchObject({ added: 5, removed: 1, files: 2, branch: 'feature' });
    const cache = new DiffStatsCache(10_000);
    const [a, b] = await Promise.all([cache.get(repo), cache.get(repo)]);
    expect(a).toBe(b);
    expect(await computeDiffStats(track(makeTempDir()))).toMatchObject({ added: 0, removed: 0, files: 0 });
  });
});

describe('changes: stage, unstage, revert, commit', () => {
  const twoHunks = (dir: string) => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    writeFile(dir, 'f.txt', `${lines.join('\n')}\n`);
    gitSync(dir, 'add', 'f.txt');
    gitSync(dir, 'commit', '-q', '-m', 'add f');
    lines[1] = 'line 2 CHANGED';
    lines[27] = 'line 28 CHANGED';
    writeFile(dir, 'f.txt', `${lines.join('\n')}\n`);
  };

  it('parses porcelain v2 status including renames and untracked files', () => {
    const out = ['1 .M N... 100644 100644 100644 abc abc src/a b.ts', '2 R. N... 100644 100644 100644 abc abc R100 new.ts', 'old.ts', '? notes.md', ''].join('\0');
    expect(parseStatus(out)).toEqual([
      { path: 'new.ts', origPath: 'old.ts', staged: 'R', unstaged: null, untracked: false, conflicted: false },
      { path: 'notes.md', origPath: null, staged: null, unstaged: null, untracked: true, conflicted: false },
      { path: 'src/a b.ts', origPath: null, staged: null, unstaged: 'M', untracked: false, conflicted: false }
    ]);
  });

  it('stages and unstages individual hunks', async () => {
    const repo = track(makeRepo());
    twoHunks(repo);
    const diff = await fileDiff(repo, 'f.txt', false);
    expect(diff.hunks).toHaveLength(2);
    expect(diff).toMatchObject({ added: 2, removed: 2 });
    await stageHunk(repo, 'f.txt', 0);
    const staged = await fileDiff(repo, 'f.txt', true);
    expect(staged.hunks).toHaveLength(1);
    expect(staged.hunks[0]!.lines.join('\n')).toContain('+line 2 CHANGED');
    expect((await fileDiff(repo, 'f.txt', false)).hunks).toHaveLength(1);
    await unstageHunk(repo, 'f.txt', 0);
    expect((await fileDiff(repo, 'f.txt', true)).hunks).toHaveLength(0);
    expect((await listChanges(repo))[0]).toMatchObject({ path: 'f.txt', staged: null, unstaged: 'M' });
  });

  it('reverts one hunk or whole files, deleting untracked files', async () => {
    const repo = track(makeRepo());
    twoHunks(repo);
    await revertHunk(repo, 'f.txt', 1);
    const content = read(repo, 'f.txt');
    expect(content).toContain('line 2 CHANGED');
    expect(content).toContain('line 28\n');
    writeFile(repo, 'scratch.tmp', 'x');
    await revertFiles(repo, ['f.txt', 'scratch.tmp']);
    expect(read(repo, 'f.txt')).not.toContain('CHANGED');
    expect(exists(repo, 'scratch.tmp')).toBe(false);
    expect(await listChanges(repo)).toEqual([]);
  });

  it('shows new files as additions and commits staged or all changes', async () => {
    const repo = track(makeRepo());
    writeFile(repo, 'new.md', 'hello\nworld\n');
    const diff = await fileDiff(repo, 'new.md', false);
    expect(diff).toMatchObject({ added: 2, removed: 0, binary: false });
    await expect(commit(repo, 'nothing', { stageAll: false })).rejects.toMatchObject({ code: 'nothing_to_commit' });
    await stageFiles(repo, ['new.md']);
    await unstageFiles(repo, ['new.md']);
    expect((await listChanges(repo))[0]?.untracked).toBe(true);
    const sha = await commit(repo, 'Add notes\n\nWith a body.', { stageAll: true });
    expect(gitSync(repo, 'log', '-1', '--format=%H%n%s%n%b').trim()).toBe(`${sha}\nAdd notes\nWith a body.`);
    await expect(commit(repo, '   ', { stageAll: true })).rejects.toMatchObject({ code: 'empty_commit_message' });
  });
});

describe('pull requests', () => {
  it('builds compare URLs for common hosts', () => {
    expect(webUrlForRemote('git@github.com:acme/app.git')).toEqual({ host: 'github.com', url: 'https://github.com/acme/app' });
    expect(webUrlForRemote('https://user:token@github.com/acme/app.git')?.url).toBe('https://github.com/acme/app');
    expect(compareUrl('https://github.com/acme/app.git', 'main', 'graft/fix')).toBe('https://github.com/acme/app/compare/main...graft%2Ffix?expand=1');
    expect(compareUrl('git@gitlab.com:acme/app.git', 'main', 'fix')).toContain('/-/merge_requests/new?merge_request%5Bsource_branch%5D=fix');
    expect(compareUrl('https://bitbucket.org/acme/app.git', 'main', 'fix')).toBe('https://bitbucket.org/acme/app/pull-requests/new?source=fix&dest=main');
    expect(webUrlForRemote('/local/path')).toBeNull();
  });

  it('pushes the branch and returns the compare page when gh is unavailable', async () => {
    const repo = track(makeRepo());
    const bare = track(makeTempDir('graft remote (tmp) '));
    gitSync(bare, 'init', '-q', '--bare');
    gitSync(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
    gitSync(repo, 'remote', 'set-url', '--push', 'origin', bare);
    await expect(createPullRequest(repo, { ghPath: null })).rejects.toMatchObject({ code: 'pr_on_base' });
    gitSync(repo, 'switch', '-q', '-c', 'graft/feature');
    writeFile(repo, 'x.txt', 'x');
    gitSync(repo, 'add', '-A');
    gitSync(repo, 'commit', '-q', '-m', 'x');
    const result = await createPullRequest(repo, { ghPath: null });
    expect(result).toEqual({ via: 'browser', url: 'https://github.com/acme/app/compare/main...graft%2Ffeature?expand=1' });
    expect(gitSync(bare, 'branch', '--list')).toContain('graft/feature');
  });
});

describe('rewind (files, conversation, both)', () => {
  it('previews and restores files and truncates the conversation from a user message', async () => {
    const { MemorySessionStore } = await import('../../src/main/db/memorySessionStore');
    const { EMPTY_SESSION_USAGE } = await import('../../src/main/db/sessionsRepo');
    const { previewRewind, performRewind } = await import('../../src/main/agent/rewind');
    const db = openDatabase(':memory:');
    db.prepare("INSERT INTO sessions (id, kind, title, permission_mode, usage, created_at, updated_at) VALUES ('s1', 'code', 't', 'ask', '{}', 0, 0)").run();
    const repo = track(makeRepo({ 'app.ts': 'v1\n' }));
    const checkpoints = new CheckpointService(db, track(makeTempDir()));
    const store = new MemorySessionStore();
    store.add({
      id: 's1', kind: 'code', title: 't', status: 'idle', pinned: false, archived: false, unread: false, incognito: true,
      projectId: null, projectPath: repo, projectName: 'r', cwd: repo, worktreePath: null, branch: null, baseBranch: null,
      model: null, effort: null, permissionMode: 'ask', lastError: null, usage: EMPTY_SESSION_USAGE, createdAt: 0, updatedAt: 0
    });
    store.appendMessage('s1', 'user', [{ type: 'text', text: 'first task' }], {});
    store.appendMessage('s1', 'assistant', [{ type: 'text', text: 'done' }], {});
    const cp = await checkpoints.create('s1', repo, 'pending');
    const target = store.appendMessage('s1', 'user', [{ type: 'text', text: 'change app.ts' }], { checkpointId: cp.id });
    store.appendMessage('s1', 'assistant', [{ type: 'text', text: 'changed' }], {});
    writeFile(repo, 'app.ts', 'v2\n');
    writeFile(repo, 'extra.ts', 'new\n');
    const deps = { store, checkpoints, truncate: (sessionId: string, seq: number) => void store.deleteMessagesFrom(sessionId, seq) };

    const preview = await previewRewind(deps, 's1', target.id);
    expect(preview).toEqual({
      messageId: target.id,
      messagesRemoved: 2,
      files: [
        { path: 'app.ts', change: 'restore' },
        { path: 'extra.ts', change: 'delete' }
      ],
      restoredText: 'change app.ts'
    });
    const result = await performRewind(deps, 's1', target.id, 'both');
    expect(result.messagesRemoved).toBe(2);
    expect(result.undoCheckpointId).toEqual(expect.any(String));
    expect(read(repo, 'app.ts')).toBe('v1\n');
    expect(exists(repo, 'extra.ts')).toBe(false);
    expect(store.listMessages('s1').map((m) => m.content)).toEqual([[{ type: 'text', text: 'first task' }], [{ type: 'text', text: 'done' }]]);

    const first = store.listMessages('s1')[0]!;
    await expect(performRewind(deps, 's1', first.id, 'files')).rejects.toMatchObject({ code: 'no_checkpoint' });
    const assistant = store.listMessages('s1')[1]!;
    await expect(previewRewind(deps, 's1', assistant.id)).rejects.toMatchObject({ code: 'rewind_not_user' });
    db.close();
  });
});
