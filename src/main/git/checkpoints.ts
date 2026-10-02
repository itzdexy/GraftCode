import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GraftError } from '@shared/errors';
import type { Db } from '../db/database';
import { fromGitPath, git, runGit } from './git';

export interface CheckpointRecord {
  id: string;
  sessionId: string;
  messageId: string;
  repoDir: string;
  gitDir: string;
  ref: string;
  commitSha: string;
  createdAt: number;
}

export type RewindChangeKind = 'restore' | 'recreate' | 'delete';

export interface RewindChange {
  /** Path relative to the snapshot root, forward slashes. */
  path: string;
  change: RewindChangeKind;
}

export interface RewindPreview {
  checkpointId: string;
  root: string;
  changes: RewindChange[];
}

interface Target {
  root: string;
  gitDir: string;
  shadow: boolean;
  /** Git can set the project's .gitattributes aside with --attr-source (Git 2.40+). */
  attrSource: boolean;
  env: Record<string, string>;
}

/** Heavy or generated folders never captured in shadow snapshots of non-git projects. */
const SHADOW_EXCLUDES = [
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  'dist/',
  'build/',
  'out/',
  'target/',
  '.next/',
  '.nuxt/',
  '.gradle/',
  '.idea/',
  '.vs/',
  'bin/',
  'obj/',
  '.cache/',
  '*.log'
];

/** Git's well-known empty tree; used as an attribute source that defines no attributes. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * info/attributes of the private snapshot repositories. It outranks every
 * .gitattributes file, so no line-ending conversion, filter, keyword
 * expansion or re-encoding touches the snapshot bytes.
 */
const RAW_ATTRIBUTES = '* -text -eol -crlf -filter -ident -working-tree-encoding\n';

let attrSourceSupport: Promise<boolean> | null = null;

/** Whether the installed git has --attr-source (added in Git 2.40; macOS still ships 2.39). */
function supportsAttrSource(): Promise<boolean> {
  attrSourceSupport ??= runGit(['--version'], { cwd: os.homedir(), allowFail: true }).then(
    ({ stdout }) => {
      const match = /(\d+)\.(\d+)/.exec(stdout);
      return match !== null && Number(match[1]) * 1000 + Number(match[2]) >= 2040;
    },
    () => false
  );
  return attrSourceSupport;
}

function writeIfChanged(file: string, content: string): void {
  try {
    if (fs.readFileSync(file, 'utf8') === content) return;
  } catch {
    // Missing: written below.
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: 'Graft',
  GIT_AUTHOR_EMAIL: 'checkpoints@graft.local',
  GIT_COMMITTER_NAME: 'Graft',
  GIT_COMMITTER_EMAIL: 'checkpoints@graft.local'
};

interface Row {
  id: string;
  session_id: string;
  message_id: string;
  repo_dir: string;
  git_dir: string;
  ref: string;
  commit_sha: string;
  created_at: number;
}

function toRecord(row: Row): CheckpointRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id,
    repoDir: row.repo_dir,
    gitDir: row.git_dir,
    ref: row.ref,
    commitSha: row.commit_sha,
    createdAt: row.created_at
  };
}

function safeRefPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Working-tree snapshots taken before each user turn. Snapshots are built
 * in a private per-session index with line-ending conversion and attribute
 * filters off, so restores are byte-exact, and stored as commits under
 * refs/graft/checkpoints/… — no branch, HEAD or real index is touched. Folders that aren't git
 * repositories get a private shadow repository in the app's data folder, and
 * so do repositories when git is older than 2.40 (see target()).
 */
export class CheckpointService {
  /** Serializes work on each private index file (one per session and repository). */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly shadowRoot: string,
    /** Folder for the private snapshot indexes (their stat cache keeps later snapshots fast). */
    private readonly indexRoot: string = path.join(shadowRoot, '..', 'checkpoint-index'),
    /** Whether git has --attr-source; tests pass `() => Promise.resolve(false)` to exercise older git. */
    private readonly attrSource: () => Promise<boolean> = supportsAttrSource
  ) {}

  private indexFile(sessionId: string, gitDir: string): string {
    const key = createHash('sha256').update(gitDir.toLowerCase()).digest('hex').slice(0, 16);
    return path.join(this.indexRoot, safeRefPart(sessionId), `${key}.index`);
  }

  private exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.locks.set(
      key,
      next.catch(() => undefined)
    );
    return next;
  }

  private async target(workDir: string): Promise<Target> {
    const top = await runGit(['rev-parse', '--show-toplevel'], { cwd: workDir, allowFail: true });
    const attrSource = await this.attrSource();
    if (top.code === 0) {
      const root = fromGitPath(top.stdout);
      if (attrSource) {
        const gitDir = fromGitPath(await git(['rev-parse', '--absolute-git-dir'], { cwd: root }));
        return { root, gitDir, shadow: false, attrSource, env: {} };
      }
      // Older git can't set the project's .gitattributes aside, and they may convert line endings or run
      // filters, so the snapshots go to a private repository whose info/attributes outrank them. The
      // project's .gitignore files apply as usual; its info/exclude is copied over.
      const exclude = path.resolve(root, (await git(['rev-parse', '--git-path', 'info/exclude'], { cwd: root })).trim());
      return this.shadow(root, 'repo-', fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '', attrSource);
    }
    return this.shadow(path.resolve(workDir), '', `${SHADOW_EXCLUDES.join('\n')}\n`, attrSource);
  }

  /** The private repository in the app's data folder that snapshots `root`. */
  private async shadow(root: string, prefix: string, excludes: string, attrSource: boolean): Promise<Target> {
    const key = prefix + createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 24);
    const gitDir = path.join(this.shadowRoot, key);
    if (!fs.existsSync(path.join(gitDir, 'HEAD'))) {
      fs.mkdirSync(gitDir, { recursive: true });
      await git(['init', '--bare', '-q', gitDir], { cwd: this.shadowRoot });
    }
    writeIfChanged(path.join(gitDir, 'info', 'exclude'), excludes);
    return this.shadowTarget(root, gitDir, attrSource);
  }

  private shadowTarget(root: string, gitDir: string, attrSource: boolean): Target {
    // Shadow repositories made before info/attributes existed get it on first use.
    if (fs.existsSync(gitDir)) writeIfChanged(path.join(gitDir, 'info', 'attributes'), RAW_ATTRIBUTES);
    return { root, gitDir, shadow: true, attrSource, env: { GIT_DIR: gitDir, GIT_WORK_TREE: root } };
  }

  /**
   * Git options for byte-exact snapshots: no line-ending conversion and no
   * .gitattributes filters, so a restore writes back exactly the bytes that
   * were on disk (Git for Windows enables autocrlf by default).
   */
  private args(target: Target, args: string[]): string[] {
    return [
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.safecrlf=false',
      ...(target.attrSource ? [`--attr-source=${EMPTY_TREE}`] : []),
      ...(target.shadow ? ['-c', 'core.bare=false'] : []),
      ...args
    ];
  }

  /**
   * Writes the current working tree as a commit; returns commit and tree ids.
   * Uses the session's private index, never the user's: the user's index
   * holds normalized content and must not be touched.
   */
  private snapshot(target: Target, sessionId: string, message: string, parent: string | null): Promise<{ commit: string; tree: string }> {
    const indexFile = this.indexFile(sessionId, target.gitDir);
    return this.exclusive(indexFile, async () => {
      fs.mkdirSync(path.dirname(indexFile), { recursive: true });
      fs.rmSync(`${indexFile}.lock`, { force: true });
      const env = { ...target.env, GIT_INDEX_FILE: indexFile };
      await git(this.args(target, ['add', '-A', '--', '.']), { cwd: target.root, env, timeoutMs: 600_000 });
      const tree = (await git(this.args(target, ['write-tree']), { cwd: target.root, env })).trim();
      const commit = (
        await git(this.args(target, ['commit-tree', tree, '-m', message, ...(parent ? ['-p', parent] : [])]), {
          cwd: target.root,
          env: { ...env, ...AUTHOR_ENV }
        })
      ).trim();
      return { commit, tree };
    });
  }

  list(sessionId: string): CheckpointRecord[] {
    return (this.db.prepare('SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at ASC, rowid ASC').all(sessionId) as Row[]).map(toRecord);
  }

  get(id: string): CheckpointRecord {
    const row = this.db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new GraftError('checkpoint_not_found', 'That checkpoint no longer exists.');
    return toRecord(row);
  }

  forMessage(sessionId: string, messageId: string): CheckpointRecord | null {
    const row = this.db.prepare('SELECT * FROM checkpoints WHERE session_id = ? AND message_id = ?').get(sessionId, messageId) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  async create(sessionId: string, workDir: string, messageId: string): Promise<CheckpointRecord> {
    const target = await this.target(workDir);
    const previous = this.list(sessionId).filter((c) => c.gitDir === target.gitDir).at(-1);
    const { commit } = await this.snapshot(target, sessionId, `graft checkpoint for session ${sessionId}`, previous?.commitSha ?? null);
    const id = randomUUID();
    const ref = `refs/graft/checkpoints/${safeRefPart(sessionId)}/${id}`;
    await git(this.args(target, ['update-ref', ref, commit]), { cwd: target.root, env: target.env });
    this.db
      .prepare('INSERT INTO checkpoints (id, session_id, message_id, repo_dir, git_dir, ref, commit_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, sessionId, messageId, target.root, target.gitDir, ref, commit, Date.now());
    return this.get(id);
  }

  private async diff(target: Target, fromTree: string, toCommit: string): Promise<RewindChange[]> {
    const out = await git(this.args(target, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', fromTree, `${toCommit}^{tree}`]), {
      cwd: target.root,
      env: target.env
    });
    const parts = out.split('\0').filter((p) => p.length > 0);
    const changes: RewindChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i]!;
      const file = parts[i + 1]!;
      const change: RewindChangeKind = status === 'A' ? 'recreate' : status === 'D' ? 'delete' : 'restore';
      changes.push({ path: file, change });
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  private async targetFor(record: CheckpointRecord): Promise<Target> {
    // A checkpoint lives where it was taken, even if the folder was later turned into a repo or git changed.
    const attrSource = await this.attrSource();
    const shadow = path.resolve(record.gitDir).startsWith(path.resolve(this.shadowRoot));
    if (shadow) return this.shadowTarget(record.repoDir, record.gitDir, attrSource);
    if (!fs.existsSync(record.repoDir)) throw new GraftError('checkpoint_missing_dir', `The folder ${record.repoDir} no longer exists.`);
    return { root: record.repoDir, gitDir: record.gitDir, shadow: false, attrSource, env: {} };
  }

  /** What restoring a checkpoint would do to the current files. */
  async preview(checkpointId: string): Promise<RewindPreview> {
    const record = this.get(checkpointId);
    const target = await this.targetFor(record);
    const current = await this.snapshot(target, record.sessionId, 'graft rewind preview', null);
    return { checkpointId, root: target.root, changes: await this.diff(target, current.tree, record.commitSha) };
  }

  /**
   * Restores files to a checkpoint. The current state is saved first as a
   * safety checkpoint (returned) so the rewind itself can be undone.
   */
  async restore(checkpointId: string): Promise<{ changes: RewindChange[]; safetyCheckpointId: string }> {
    const record = this.get(checkpointId);
    const target = await this.targetFor(record);
    const current = await this.snapshot(target, record.sessionId, `graft safety snapshot before rewinding session ${record.sessionId}`, null);
    const changes = await this.diff(target, current.tree, record.commitSha);

    const safetyId = randomUUID();
    const safetyRef = `refs/graft/checkpoints/${safeRefPart(record.sessionId)}/${safetyId}`;
    await git(this.args(target, ['update-ref', safetyRef, current.commit]), { cwd: target.root, env: target.env });
    this.db
      .prepare('INSERT INTO checkpoints (id, session_id, message_id, repo_dir, git_dir, ref, commit_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(safetyId, record.sessionId, `rewind-safety:${checkpointId}`, target.root, target.gitDir, safetyRef, current.commit, Date.now());

    const write = changes.filter((c) => c.change !== 'delete').map((c) => c.path);
    if (write.length > 0) {
      const tempIndex = path.join(os.tmpdir(), `graft-index-${randomUUID()}`);
      try {
        const env = { ...target.env, GIT_INDEX_FILE: tempIndex };
        await git(this.args(target, ['read-tree', record.commitSha]), { cwd: target.root, env });
        await git(this.args(target, ['checkout-index', '-f', '-z', '--stdin']), { cwd: target.root, env, input: `${write.join('\0')}\0` });
      } finally {
        fs.rmSync(tempIndex, { force: true });
        fs.rmSync(`${tempIndex}.lock`, { force: true });
      }
    }
    for (const change of changes.filter((c) => c.change === 'delete')) {
      const abs = path.join(target.root, ...change.path.split('/'));
      fs.rmSync(abs, { force: true });
      // Remove directories the deletion left empty, up to the snapshot root.
      let dir = path.dirname(abs);
      while (dir.startsWith(target.root) && dir !== target.root) {
        try {
          if (fs.readdirSync(dir).length > 0) break;
          fs.rmdirSync(dir);
        } catch {
          break;
        }
        dir = path.dirname(dir);
      }
    }
    return { changes, safetyCheckpointId: safetyId };
  }

  /** Deletes a session's checkpoint refs (objects are left for git's normal garbage collection). */
  async deleteForSession(sessionId: string): Promise<void> {
    for (const record of this.list(sessionId)) {
      if (fs.existsSync(record.repoDir) || fs.existsSync(record.gitDir)) {
        const target = await this.targetFor(record).catch(() => null);
        if (target) await runGit(this.args(target, ['update-ref', '-d', record.ref]), { cwd: target.root, env: target.env, allowFail: true });
      }
    }
    this.db.prepare('DELETE FROM checkpoints WHERE session_id = ?').run(sessionId);
    fs.rmSync(path.join(this.indexRoot, safeRefPart(sessionId)), { recursive: true, force: true });
  }
}
