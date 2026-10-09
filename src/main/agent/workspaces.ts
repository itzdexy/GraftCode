import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GraftError } from '@shared/errors';
import type { AgentWorkspace } from '@shared/schemas/agentRuns';
import type { CheckpointService, WorkspaceSnapshot } from '../git/checkpoints';
import { git, runGit } from '../git/git';
import { outsideScope } from './writeScope';

export interface WorkspaceLease {
  id: string;
  root: string;
  cwd: string;
  base: WorkspaceSnapshot;
  info: AgentWorkspace;
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Private writer checkouts; merges are serialized and never stage or reset the user's index. */
export class AgentWorkspaces {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly snapshots: Pick<CheckpointService, 'captureWorkspace'>, private readonly root: string) {}

  private exclusive<T>(root: string, work: () => Promise<T>): Promise<T> {
    const key = process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    const tail = next.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key); });
    return next;
  }

  private args(base: WorkspaceSnapshot, command: string[]): string[] {
    return [`--git-dir=${base.gitDir}`, '-c', 'core.bare=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
      '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
      // git apply writes patch bytes directly; --attr-source can crash Git for Windows during apply.
      ...(base.attrSource && command[0] !== 'apply' ? [`--attr-source=${EMPTY_TREE}`] : []), ...command];
  }

  private save(lease: WorkspaceLease): void {
    const file = path.join(this.root, `${lease.id}.json`);
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, id: lease.id, root: lease.root, cwd: lease.cwd, base: lease.base, info: lease.info }), { mode: 0o600, flush: true });
    fs.renameSync(temp, file);
  }

  async create(cwd: string, signal: AbortSignal): Promise<WorkspaceLease> {
    signal.throwIfAborted();
    fs.mkdirSync(this.root, { recursive: true });
    const id = randomUUID();
    const base = await this.exclusive(cwd, () => this.snapshots.captureWorkspace(id, cwd, undefined, signal));
    signal.throwIfAborted();
    const dir = path.join(this.root, id);
    const branch = `graft/agent-${id}`;
    const lease: WorkspaceLease = { id, root: dir, cwd: path.join(dir, path.relative(base.root, path.resolve(cwd))), base,
      info: { path: dir, branch, baseCommit: base.commitSha, state: 'working', patchPath: null } };
    this.save(lease);
    try {
      await git(this.args(base, ['worktree', 'add', '-b', branch, dir, base.commitSha]), { cwd: base.root, signal });
      signal.throwIfAborted();
      return lease;
    } catch (error) {
      lease.info = { ...lease.info, state: 'retained' }; this.save(lease);
      throw new GraftError('agent_workspace_failed', `Couldn't prepare the private writer checkout. Recovery record: ${path.join(this.root, `${id}.json`)}. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Failed/cancelled work stays on disk with a manifest; nothing is discarded automatically. */
  retain(lease: WorkspaceLease): AgentWorkspace {
    lease.info = { ...lease.info, state: 'retained' }; this.save(lease);
    return lease.info;
  }

  async integrate(lease: WorkspaceLease, scopes: string[], signal: AbortSignal, touched: string[] = []): Promise<AgentWorkspace> {
    signal.throwIfAborted();
    try {
      const result = await this.snapshots.captureWorkspace(`${lease.id}-result`, lease.root, lease.base, signal);
      signal.throwIfAborted();
      const options = { cwd: lease.cwd, signal };
      const changed = (await git(this.args(lease.base, ['diff', '--no-renames', '--name-only', '-z', lease.base.commitSha, result.commitSha]), options)).split('\0').filter(Boolean);
      const patch = await git(this.args(lease.base, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', lease.base.commitSha, result.commitSha]), options);
      if (Buffer.byteLength(patch) > 32 * 1024 * 1024) throw new GraftError('agent_patch_limit', 'The writer patch exceeds 32 MiB. Its checkout is retained for manual review.');
      const patchPath = path.join(this.root, `${lease.id}.patch`);
      fs.writeFileSync(patchPath, patch, { mode: 0o600, flush: true });
      lease.info = { ...lease.info, patchPath }; this.save(lease);
      const paths = changed.map((file) => path.join(lease.root, file));
      const outside = outsideScope(paths, scopes.length ? scopes : ['**'], lease.cwd);
      if (outside.length) throw new GraftError('agent_scope_conflict', `The writer changed paths outside its assignment: ${outside.join(', ')}.`);
      // A Write/Edit of an ignored file must not be silently reported as integrated.
      if (touched.length) {
        const ignored = await runGit(this.args(lease.base, ['check-ignore', '--no-index', '-z', '--stdin']), { ...options,
          env: { GIT_WORK_TREE: lease.root }, input: `${touched.map((file) => path.resolve(lease.cwd, file)).join('\0')}\0`, allowFail: true });
        if (ignored.code === 0) throw new GraftError('agent_ignored_change', 'The writer edited ignored files. Those files remain in its private checkout for review.');
        if (ignored.code !== 1) throw new GraftError('agent_workspace_failed', 'Could not validate the writer file list.');
      }
      await this.exclusive(lease.base.root, async () => {
        signal.throwIfAborted();
        if (changed.length === 0) return;
        const current = await this.snapshots.captureWorkspace(`${lease.id}-current`, lease.base.root, lease.base, signal);
        signal.throwIfAborted();
        const divergence = await runGit(this.args(lease.base, ['diff', '--quiet', lease.base.commitSha, current.commitSha, '--', ...changed]), { cwd: lease.base.root, signal, allowFail: true });
        if (divergence.code !== 0) throw new GraftError('agent_workspace_conflict', 'The destination changed since this writer started. Its patch and checkout are retained; review the conflict before integrating.');
        // The exact diff is applied to files only. No --index, checkout or branch merge touches user staging.
        const env = { GIT_WORK_TREE: lease.base.root };
        await git(this.args(lease.base, ['apply', '--check', '--binary', '--whitespace=nowarn']), { cwd: lease.base.root, env, signal, input: patch });
        signal.throwIfAborted();
        // Once applying starts, finish the atomic git-apply operation even if cancellation arrives.
        await git(this.args(lease.base, ['apply', '--binary', '--whitespace=nowarn']), { cwd: lease.base.root, env, input: patch });
      });
      lease.info = { ...lease.info, state: 'integrated' }; this.save(lease);
      return lease.info;
    } catch (error) {
      this.retain(lease);
      throw new GraftError(error instanceof GraftError ? error.code : 'agent_workspace_conflict',
        `${error instanceof Error ? error.message : String(error)} Private checkout: ${lease.cwd}.`, { cause: error });
    }
  }
}
