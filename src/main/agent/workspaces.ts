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

/** What a writer changed: the paths (from the repository's root), the patch, and each file's line counts. */
export interface CapturedChanges {
  changed: string[];
  patch: string;
  stats: Array<{ path: string; added: number; removed: number; binary: boolean }>;
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** The dependency folders a checkout can borrow from its project (see attempts.ts): never copied into it, so only ever a link there. */
export const DEPENDENCY_DIRS = ['node_modules'];

/** `git diff --numstat -z` lines: added, removed, path ("-" counts for a binary file). */
export function parseNumstat(out: string): CapturedChanges['stats'] {
  return out.split('\0').flatMap((entry) => {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(entry);
    if (!match) return [];
    const binary = match[1] === '-' || match[2] === '-';
    return [{ path: match[3]!, added: binary ? 0 : Number(match[1]), removed: binary ? 0 : Number(match[2]), binary }];
  });
}

/** Removes a link without following it: what it points to belongs to the project. A real folder is left alone. */
export function unlinkLink(link: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(link);
  } catch {
    return;
  }
  if (!stat.isSymbolicLink()) return;
  try {
    fs.unlinkSync(link);
  } catch {
    // A directory junction on Windows can refuse unlink; rmdir takes the junction itself, never its target.
    fs.rmdirSync(link);
  }
}

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

  private manifest(id: string): string {
    return path.join(this.root, `${id}.json`);
  }

  private save(lease: WorkspaceLease): void {
    const file = this.manifest(lease.id);
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, id: lease.id, root: lease.root, cwd: lease.cwd, base: lease.base, info: lease.info }), { mode: 0o600, flush: true });
    fs.renameSync(temp, file);
  }

  /** A checkout from its record, as after a restart; null when the record is gone. */
  load(id: string): WorkspaceLease | null {
    // An id names a file in this folder and nothing else.
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    try {
      const saved = JSON.parse(fs.readFileSync(this.manifest(id), 'utf8')) as WorkspaceLease & { version: number };
      return { id: saved.id, root: saved.root, cwd: saved.cwd, base: saved.base, info: saved.info };
    } catch {
      return null;
    }
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

  /** What the writer changed, against the files it started from. The patch is kept beside the record. */
  async capture(lease: WorkspaceLease, signal: AbortSignal): Promise<CapturedChanges> {
    const result = await this.snapshots.captureWorkspace(`${lease.id}-result`, lease.root, lease.base, signal);
    signal.throwIfAborted();
    const options = { cwd: lease.cwd, signal };
    const range = [lease.base.commitSha, result.commitSha];
    const changed = (await git(this.args(lease.base, ['diff', '--no-renames', '--name-only', '-z', ...range]), options)).split('\0').filter(Boolean);
    const patch = await git(this.args(lease.base, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', ...range]), options);
    if (Buffer.byteLength(patch) > 32 * 1024 * 1024) throw new GraftError('agent_patch_limit', 'The writer patch exceeds 32 MiB. Its checkout is retained for manual review.');
    const patchPath = path.join(this.root, `${lease.id}.patch`);
    fs.writeFileSync(patchPath, patch, { mode: 0o600, flush: true });
    lease.info = { ...lease.info, patchPath }; this.save(lease);
    const stats = parseNumstat(await git(this.args(lease.base, ['diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--numstat', '-z', ...range]), options));
    return { changed, patch, stats };
  }

  /** Of the files a writer edited (Write/Edit), those Git ignores: they are never in its patch. */
  async ignoredOf(lease: WorkspaceLease, touched: string[], signal: AbortSignal): Promise<string[]> {
    if (touched.length === 0) return [];
    const ignored = await runGit(this.args(lease.base, ['check-ignore', '--no-index', '-z', '--stdin']), { cwd: lease.cwd, signal,
      env: { GIT_WORK_TREE: lease.root }, input: `${touched.map((file) => path.resolve(lease.cwd, file)).join('\0')}\0`, allowFail: true });
    if (ignored.code === 1) return [];
    if (ignored.code !== 0) throw new GraftError('agent_workspace_failed', 'Could not validate the writer file list.');
    return ignored.stdout.split('\0').filter(Boolean);
  }

  /**
   * Applies a writer's patch to its destination, after checking that none of the files it changed differ there from
   * where the writer started. `diverged` gets the files that do; the error says what to do about them.
   */
  async applyPatch(lease: WorkspaceLease, changed: string[], patch: string, signal: AbortSignal, conflict?: (diverged: string[]) => GraftError): Promise<void> {
    await this.exclusive(lease.base.root, async () => {
      signal.throwIfAborted();
      if (changed.length === 0) return;
      const current = await this.snapshots.captureWorkspace(`${lease.id}-current`, lease.base.root, lease.base, signal);
      signal.throwIfAborted();
      const divergence = await runGit(this.args(lease.base, ['diff', '--no-renames', '--name-only', '-z', lease.base.commitSha, current.commitSha, '--', ...changed]), { cwd: lease.base.root, signal, allowFail: true });
      const diverged = divergence.stdout.split('\0').filter(Boolean);
      if (divergence.code !== 0 || diverged.length > 0) {
        throw conflict?.(diverged) ?? new GraftError('agent_workspace_conflict', 'The destination changed since this writer started. Its patch and checkout are retained; review the conflict before integrating.');
      }
      // The exact diff is applied to files only. No --index, checkout or branch merge touches user staging.
      const env = { GIT_WORK_TREE: lease.base.root };
      await git(this.args(lease.base, ['apply', '--check', '--binary', '--whitespace=nowarn']), { cwd: lease.base.root, env, signal, input: patch });
      signal.throwIfAborted();
      // Once applying starts, finish the atomic git-apply operation even if cancellation arrives.
      await git(this.args(lease.base, ['apply', '--binary', '--whitespace=nowarn']), { cwd: lease.base.root, env, input: patch });
    });
  }

  async integrate(lease: WorkspaceLease, scopes: string[], signal: AbortSignal, touched: string[] = []): Promise<AgentWorkspace> {
    signal.throwIfAborted();
    try {
      const { changed, patch } = await this.capture(lease, signal);
      const paths = changed.map((file) => path.join(lease.root, file));
      const outside = outsideScope(paths, scopes.length ? scopes : ['**'], lease.cwd);
      if (outside.length) throw new GraftError('agent_scope_conflict', `The writer changed paths outside its assignment: ${outside.join(', ')}.`);
      // A Write/Edit of an ignored file must not be silently reported as integrated.
      if ((await this.ignoredOf(lease, touched, signal)).length > 0) throw new GraftError('agent_ignored_change', 'The writer edited ignored files. Those files remain in its private checkout for review.');
      await this.applyPatch(lease, changed, patch, signal);
      lease.info = { ...lease.info, state: 'integrated' }; this.save(lease);
      return lease.info;
    } catch (error) {
      this.retain(lease);
      throw new GraftError(error instanceof GraftError ? error.code : 'agent_workspace_conflict',
        `${error instanceof Error ? error.message : String(error)} Private checkout: ${lease.cwd}.`, { cause: error });
    }
  }

  /**
   * Removes a checkout, its branch and its record; `keepPatch` keeps the patch file (and the record naming it) of
   * one that was applied. Dependency links are taken out first, and the folder is removed without following any
   * link, so removing a checkout never reaches the project's own folders.
   */
  async remove(lease: WorkspaceLease, keepPatch = false): Promise<void> {
    // A checkout lives in this folder and nowhere else: a record that says otherwise removes nothing.
    if (path.dirname(path.resolve(lease.root)) !== path.resolve(this.root)) throw new GraftError('agent_workspace_failed', `${lease.root} is not a private checkout, so Graft doesn't remove it.`);
    for (const dir of new Set([lease.root, lease.cwd])) for (const name of DEPENDENCY_DIRS) unlinkLink(path.join(dir, name));
    fs.rmSync(lease.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await runGit(this.args(lease.base, ['worktree', 'prune']), { cwd: lease.base.root, allowFail: true });
    await runGit(this.args(lease.base, ['branch', '-D', lease.info.branch]), { cwd: lease.base.root, allowFail: true });
    if (keepPatch) {
      lease.info = { ...lease.info, state: 'integrated' }; this.save(lease);
      return;
    }
    if (lease.info.patchPath) fs.rmSync(lease.info.patchPath, { force: true });
    fs.rmSync(this.manifest(lease.id), { force: true });
  }
}
