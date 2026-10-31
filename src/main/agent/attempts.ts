import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GraftError } from '@shared/errors';
import type { AgentEvent } from '@shared/schemas/agentEvents';
import type { Attempt, AttemptSet } from '@shared/schemas/attempts';
import type { CheckReport } from '@shared/schemas/checkReport';
import { addUsage, EMPTY_USAGE, type Usage } from '@shared/schemas/common';
import type { ChecksConfig } from '@shared/schemas/config';
import type { StoredMessage } from '@shared/schemas/messages';
import type { ModelInfo } from '@shared/schemas/models';
import { maskSecrets } from '@shared/secrets';
import type { SessionStore } from '../db/sessionsRepo';
import type { ShellManager } from '../tools/shell/shellManager';
import { runChecks } from './checks';
import { runGraph, type GraphControl } from './orchestrator';
import { DEPENDENCY_DIRS, unlinkLink, type AgentWorkspaces, type WorkspaceLease } from './workspaces';

/**
 * Best of N: one message run as 2 to 4 attempts. Each attempt is a writing agent in
 * a private checkout (workspaces.ts) that starts from the session's folder as it is
 * when the message is sent. When its agent finishes, its changes are taken, the
 * project's checks run in its checkout, and it waits as a candidate. Nothing reaches
 * the session's folder until the user applies one attempt, through the same
 * divergence check writers integrate with; applying or discarding removes the
 * checkouts. The state is kept on the card's message, so it survives a restart.
 */

/** As long as a writing agent of a group may work (roles.ts, implementer). */
const ATTEMPT_TIMEOUT_MS = 45 * 60_000;
const REPORT_MAX = 4_000;
/** The most of an attempt's patch the diff view is sent; files past it are listed without their lines. */
const DIFF_SHOWN_MAX = 2 * 1024 * 1024;
const FILES_NAMED = 5;
const ACTIVE = new Set<Attempt['status']>(['queued', 'running', 'checking']);

/** How an attempt is named where it asks for something: on its permission cards, and to stop it. */
export function attemptLabel(index: number, model: string): string {
  return `Attempt ${String(index)} · ${model}`;
}

/** Whether a folder is in a Git repository: it, or a folder above it, has .git (a folder, or the file of a worktree). */
export function insideGitRepo(folder: string): boolean {
  for (let dir = path.resolve(folder); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

/**
 * Links the project's dependency folders into a checkout that has none of its own, for its checks: a checkout gets
 * no ignored files, so `npm test` there would find no node_modules. Returns the links made; unlinkLink takes them out.
 */
export function linkDependencies(pairs: Array<[project: string, checkout: string]>): string[] {
  const isFolder = (p: string): boolean => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const present = (p: string): boolean => {
    try {
      fs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };
  const made: string[] = [];
  for (const [project, checkout] of pairs) {
    for (const name of DEPENDENCY_DIRS) {
      const target = path.join(project, name);
      const link = path.join(checkout, name);
      if (made.includes(link) || !isFolder(target) || present(link)) continue;
      try {
        // A junction on Windows needs no developer mode, and like a link it is removed without its target.
        fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
        made.push(link);
      } catch {
        // The checks then run without it, as they would have before.
      }
    }
  }
  return made;
}

/** "a.ts, b.ts and 3 more". */
function named(paths: string[]): string {
  const shown = paths.slice(0, FILES_NAMED);
  const more = paths.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${String(more)} more`;
  return shown.length <= 1 ? (shown[0] ?? '') : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1) ?? ''}`;
}

/** Git quotes a path with unusual characters ("a/sp\303\251cial"): the bytes come back as UTF-8. */
function unquote(text: string): string {
  if (!text.startsWith('"')) return text;
  const bytes: number[] = [];
  const body = text.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[i + 1] ?? '';
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(({ n: 10, t: 9, r: 13 } as Record<string, number>)[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * A Git patch file by file, for the diff view. Without renames both sides of "diff --git" name the same path, so
 * the line splits in half. A binary file's bytes are not shown, and past `max` characters files come without lines.
 */
export function splitPatch(text: string, max = DIFF_SHOWN_MAX): { files: Array<{ path: string; patch: string; binary: boolean }>; truncated: boolean } {
  let size = 0;
  let truncated = false;
  const files = text
    .split(/^(?=diff --git )/m)
    .filter((chunk) => chunk.startsWith('diff --git '))
    .map((chunk) => {
      const end = chunk.indexOf('\n');
      const line = chunk.slice('diff --git '.length, end === -1 ? undefined : end);
      // "a/X b/X": the first half, without its "a/".
      const file = unquote(line.slice(0, (line.length - 1) / 2)).replace(/^a\//, '');
      const binary = /^GIT binary patch$|^Binary files /m.test(chunk);
      size += chunk.length;
      const shown = !binary && size <= max;
      if (!binary && !shown) truncated = true;
      return { path: file, patch: shown ? chunk : '', binary };
    });
  return { files, truncated };
}

/** What one attempt's agent is given beside its checkout: how it reports what it used and what it is doing. */
export interface AttemptAgentCall {
  index: number;
  of: number;
  lease: WorkspaceLease;
  /** One request's usage: added to the attempt's own totals on the card. */
  usage(usage: Usage, costUsd: number | null): void;
  /** What it is doing now ("Edit a.ts"). */
  activity(text: string): void;
}

export interface AttemptsStart {
  /** The message the attempts answer, and the turn they run in. */
  messageId: string;
  turnId: string;
  /** The session's folder: each checkout starts from it as it is now. */
  cwd: string;
  /** One per attempt. */
  models: ModelInfo[];
  /** How many run at once (Settings → Models → Agents). */
  concurrency: number;
  /** The project's checks, run in each checkout whose attempt changed something; null runs none, and `unchecked` says why. */
  checks: ChecksConfig | null;
  unchecked: string | null;
  /** Runs one attempt's agent in its checkout: its final words and the files it edited. Throws when it did not finish. */
  agent(call: AttemptAgentCall, signal: AbortSignal): Promise<{ report: string; touched: string[] }>;
}

export interface AttemptsDeps {
  sessionId: string;
  store: SessionStore;
  workspaces: AgentWorkspaces | null;
  shells: ShellManager;
  emit(event: AgentEvent): void;
  /** Takes the permission card of an attempt that was stopped off the screen: nothing waits for its answer now. */
  dropPrompt(label: string): void;
  log(level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, string | number | boolean>): void;
}

/** The attempts of one session's messages: running them, and applying, discarding and stopping them from their card. */
export class AttemptRunner {
  /** The sets running in this runtime, with the way to stop one attempt of each. */
  private readonly live = new Map<string, GraphControl>();
  /** Sets being applied or discarded right now: a second click must not do it twice. */
  private readonly settling = new Set<string>();

  constructor(private readonly deps: AttemptsDeps) {}

  private workspaces(): AgentWorkspaces {
    if (!this.deps.workspaces) throw new GraftError('attempts_unavailable', 'Attempts need private checkouts, and this session has none.');
    return this.deps.workspaces;
  }

  /** A set from its card, which has to be a message of this session. */
  private load(setId: string): AttemptSet {
    const message = this.deps.store.getMessage(setId);
    const set = message?.sessionId === this.deps.sessionId ? message.meta.attempts : undefined;
    if (!set) throw new GraftError('attempts_not_found', 'Those attempts are no longer in this session.');
    return set;
  }

  private save(set: AttemptSet): AttemptSet {
    this.deps.emit({ type: 'message', message: this.deps.store.updateMessageMeta(set.id, { attempts: set }) });
    return set;
  }

  /** Said in the conversation, so the agent reads later what became of the message. */
  private say(text: string): void {
    this.deps.emit({ type: 'message', message: this.deps.store.appendMessage(this.deps.sessionId, 'assistant', [{ type: 'text', text }], {}) });
  }

  running(setId: string): boolean {
    return this.live.has(setId);
  }

  async run(input: AttemptsStart, signal: AbortSignal): Promise<AttemptSet> {
    const workspaces = this.workspaces();
    const id = randomUUID();
    let set: AttemptSet = {
      id,
      messageId: input.messageId,
      status: 'running',
      applied: null,
      note: null,
      createdAt: Date.now(),
      attempts: input.models.map((model, i) => ({
        index: i + 1,
        model: { ...model.ref, label: model.label },
        status: 'queued',
        error: null,
        workspaceId: null,
        activity: null,
        files: [],
        checks: null,
        notes: [],
        usage: EMPTY_USAGE,
        costUsd: null,
        startedAt: null,
        endedAt: null,
        report: ''
      }))
    };
    // The card is a notice: shown, never sent. What the agent later reads is said when one is applied or all are discarded.
    const card = this.deps.store.appendMessage(this.deps.sessionId, 'assistant', [{ type: 'text', text: `Sent as ${String(set.attempts.length)} attempts.` }], { kind: 'notice', turnId: input.turnId, attempts: set }, id);
    this.deps.emit({ type: 'message', message: card });
    const current = (index: number): Attempt => set.attempts[index - 1]!;
    const change = (index: number, patch: Partial<Attempt>): void => {
      set = this.save({ ...set, attempts: set.attempts.map((a) => (a.index === index ? { ...a, ...patch } : a)) });
    };
    await runGraph<null>({
      nodes: set.attempts.map((a) => ({ id: String(a.index), dependsOn: [], exclusive: false, maxAttempts: 1, timeoutMs: ATTEMPT_TIMEOUT_MS })),
      concurrency: input.concurrency,
      signal,
      isRetryable: () => false,
      onControl: (control) => this.live.set(id, control),
      onState: (node, state) => {
        const index = Number(node);
        const now = Date.now();
        if (state.status === 'running') change(index, { status: 'running', startedAt: now });
        // A limit of the turn stops an attempt; it did not fail at the work (see the run below).
        else if (state.status === 'failed' && current(index).status !== 'stopped') change(index, { status: 'failed', error: state.error, activity: null, endedAt: now });
        else if (state.status === 'cancelled' || state.status === 'skipped') change(index, { status: 'stopped', error: 'Stopped.', activity: null, endedAt: now });
      },
      run: async (node, _attempt, nodeSignal) => {
        const index = Number(node.id);
        try {
          await this.attempt(index, input, workspaces, nodeSignal, change, current);
        } catch (error) {
          if (error instanceof GraftError && error.code === 'turn_limit') change(index, { status: 'stopped', error: error.message, activity: null, endedAt: Date.now() });
          throw error;
        }
        return null;
      }
    }).finally(() => this.live.delete(id));
    return this.save({ ...set, status: 'open' });
  }

  private async attempt(
    index: number,
    input: AttemptsStart,
    workspaces: AgentWorkspaces,
    signal: AbortSignal,
    change: (index: number, patch: Partial<Attempt>) => void,
    current: (index: number) => Attempt
  ): Promise<void> {
    const lease = await workspaces.create(input.cwd, signal);
    change(index, { workspaceId: lease.id });
    const { report, touched } = await input.agent(
      {
        index,
        of: input.models.length,
        lease,
        usage: (usage, costUsd) => {
          const now = current(index);
          change(index, { usage: addUsage(now.usage, usage), costUsd: costUsd === null ? now.costUsd : (now.costUsd ?? 0) + costUsd });
        },
        activity: (text) => change(index, { activity: text })
      },
      signal
    );
    // Taken before the checks run: the attempt is what its agent wrote, not what a check generated.
    const captured = await workspaces.capture(lease, signal);
    const ignored = (await workspaces.ignoredOf(lease, touched, signal)).map((file) => path.relative(lease.cwd, file));
    const notes = [
      ...(ignored.length > 0 ? [`Its edits to ignored files are not part of it: ${named(ignored)}.`] : []),
      ...(input.checks === null && input.unchecked !== null && captured.changed.length > 0 ? [input.unchecked] : [])
    ];
    change(index, { files: captured.stats, report: report.slice(0, REPORT_MAX), notes, activity: null });
    if (input.checks && captured.changed.length > 0) {
      change(index, { status: 'checking' });
      change(index, { checks: await this.check(lease, input.cwd, input.checks, signal) });
    }
    signal.throwIfAborted();
    change(index, { status: 'candidate', endedAt: Date.now() });
  }

  /** The project's checks in a checkout, in a shell of its own, with the project's dependency folders linked in while they run. */
  private async check(lease: WorkspaceLease, cwd: string, config: ChecksConfig, signal: AbortSignal): Promise<CheckReport> {
    const shell = `${this.deps.sessionId}:attempt:${lease.id}`;
    const target = this.deps.shells.sandboxFor(this.deps.sessionId);
    if (target) await this.deps.shells.setSandbox(shell, { ...target, workspace: fs.realpathSync(lease.cwd) });
    this.deps.shells.resetSession(shell, lease.cwd);
    const links = linkDependencies([
      [cwd, lease.cwd],
      [lease.base.root, lease.root]
    ]);
    try {
      return await runChecks(config, 1, { sessionId: shell, cwd: lease.cwd, signal, shells: this.deps.shells });
    } finally {
      for (const link of links) unlinkLink(link);
      await this.deps.shells.disposeSession(shell);
    }
  }

  /** Removes the checkouts of a set; `keep` keeps the patch of the attempt that was applied. Returns what could not be removed. */
  private async removeCheckouts(set: AttemptSet, keep: number | null): Promise<string[]> {
    const workspaces = this.workspaces();
    const left: string[] = [];
    for (const attempt of set.attempts) {
      const lease = attempt.workspaceId ? workspaces.load(attempt.workspaceId) : null;
      if (!lease) continue;
      try {
        await workspaces.remove(lease, attempt.index === keep);
      } catch (error) {
        left.push(lease.root);
        this.deps.log('warn', 'Could not remove the checkout of an attempt', { session: this.deps.sessionId, message: (error as Error).message });
      }
    }
    return left;
  }

  private leftNote(left: string[]): string | null {
    return left.length === 0 ? null : `Couldn't remove ${left.length === 1 ? 'a checkout' : `${String(left.length)} checkouts`}, so ${left.length === 1 ? 'it stays' : 'they stay'} on this computer: ${left.join(', ')}. Delete ${left.length === 1 ? 'it' : 'them'} once nothing uses ${left.length === 1 ? 'it' : 'them'}.`;
  }

  /** Runs `work` on a set that is not running, and not already being applied or discarded. */
  private async settle<T>(setId: string, work: (set: AttemptSet) => Promise<T>): Promise<T> {
    if (this.live.has(setId)) throw new GraftError('attempts_running', 'The attempts are still running. Wait for them to finish, or stop them first.');
    if (this.settling.has(setId)) throw new GraftError('attempts_busy', 'Those attempts are being applied or discarded already.');
    this.settling.add(setId);
    try {
      return await work(this.load(setId));
    } finally {
      this.settling.delete(setId);
    }
  }

  /**
   * Applies one attempt to the session's folder, through the check that refuses it when a file it changed differs
   * there from where the attempts started. Then every checkout goes; the applied one's patch is kept for its diff.
   */
  apply(setId: string, index: number): Promise<string[]> {
    return this.settle(setId, async (set) => {
      if (set.status === 'applied') throw new GraftError('attempts_applied', `Attempt ${String(set.applied)} was applied already.`);
      if (set.status === 'discarded') throw new GraftError('attempts_discarded', 'Those attempts were discarded.');
      const attempt = set.attempts.find((a) => a.index === index);
      if (attempt?.status !== 'candidate') throw new GraftError('attempt_not_ready', `Attempt ${String(index)} didn't finish, so there is nothing of it to apply.`);
      if (attempt.files.length === 0) throw new GraftError('attempt_empty', `Attempt ${String(index)} changed no files, so there is nothing to apply.`);
      const workspaces = this.workspaces();
      const lease = attempt.workspaceId ? workspaces.load(attempt.workspaceId) : null;
      let patch: string | null;
      try {
        patch = lease?.info.patchPath ? fs.readFileSync(lease.info.patchPath, 'utf8') : null;
      } catch {
        patch = null;
      }
      if (!lease || patch === null) throw new GraftError('attempt_gone', `Attempt ${String(index)}'s changes are no longer on this computer, so it can't be applied. Discard the attempts and send the message again.`);
      const files = attempt.files.map((f) => f.path);
      await workspaces.applyPatch(lease, files, patch, new AbortController().signal, (diverged) =>
        new GraftError(
          'attempt_conflict',
          `Attempt ${String(index)} wasn't applied: ${diverged.length > 0 ? named(diverged) : 'files it changed'} changed in the folder since the attempts started. Nothing was changed. Undo those changes and apply again, or discard the attempts and send the message again.`
        )
      );
      const left = await this.removeCheckouts(set, index);
      this.save({ ...set, status: 'applied', applied: index, note: this.leftNote(left) });
      const report = attempt.report.trim();
      this.say(
        [
          `Applied attempt ${String(index)} of ${String(set.attempts.length)} (${attempt.model.label}) to the folder. It changed ${named(files)}.`,
          // Its words go to the model with the conversation from now on: a key it printed is masked first.
          ...(report ? [`Its report:\n${maskSecrets(report)}`] : [])
        ].join('\n\n')
      );
      return files;
    });
  }

  /** Removes every checkout of a set; nothing in the session's folder changes. */
  discard(setId: string): Promise<void> {
    return this.settle(setId, async (set) => {
      if (set.status === 'applied' || set.status === 'discarded') return;
      const left = await this.removeCheckouts(set, null);
      this.save({ ...set, status: 'discarded', note: this.leftNote(left) });
      this.say(`Discarded the ${String(set.attempts.length)} attempts at this message. The folder is as it was.`);
    });
  }

  /** Stops one attempt that is running, or all of them (null). False when none was running. */
  stop(setId: string, index: number | null): boolean {
    const control = this.live.get(setId);
    if (!control) return false;
    const set = this.load(setId);
    let stopped = false;
    for (const attempt of set.attempts) {
      if (index !== null && attempt.index !== index) continue;
      if (!control.stop(String(attempt.index))) continue;
      stopped = true;
      this.deps.dropPrompt(attemptLabel(attempt.index, attempt.model.label));
    }
    return stopped;
  }

  /** What an attempt changed, file by file. */
  diff(setId: string, index: number): { files: Array<{ path: string; patch: string; binary: boolean }>; truncated: boolean } {
    const attempt = this.load(setId).attempts.find((a) => a.index === index);
    const lease = attempt?.workspaceId ? this.workspaces().load(attempt.workspaceId) : null;
    if (!lease?.info.patchPath) throw new GraftError('attempt_no_diff', `Attempt ${String(index)} has no changes to show yet.`);
    try {
      return splitPatch(fs.readFileSync(lease.info.patchPath, 'utf8'));
    } catch {
      throw new GraftError('attempt_no_diff', `Attempt ${String(index)}'s changes are no longer on this computer.`);
    }
  }

  /**
   * Attempts the store says are running, when this runtime runs none, were running when Graft stopped. They are
   * stopped now, and the card says so; those that had finished can still be applied. Links a check had made are
   * taken out of their checkouts.
   */
  recover(): void {
    let messages: StoredMessage[];
    try {
      messages = this.deps.store.listMessages(this.deps.sessionId);
    } catch {
      return;
    }
    for (const message of messages) {
      const set = message.meta.attempts;
      if (set?.status !== 'running' || this.live.has(set.id)) continue;
      const now = Date.now();
      const attempts = set.attempts.map((a): Attempt => {
        if (!ACTIVE.has(a.status)) return a;
        const lease = a.workspaceId ? this.deps.workspaces?.load(a.workspaceId) : null;
        if (lease) for (const dir of new Set([lease.root, lease.cwd])) for (const name of DEPENDENCY_DIRS) unlinkLink(path.join(dir, name));
        const error = a.workspaceId
          ? 'Graft stopped while this attempt was running. What it had done stays in its checkout until you apply another attempt or discard them all.'
          : 'Graft stopped before this attempt started.';
        return { ...a, status: 'stopped', activity: null, endedAt: a.endedAt ?? now, error };
      });
      try {
        this.deps.store.updateMessageMeta(message.id, { attempts: { ...set, status: 'open', attempts, note: 'Graft stopped while these attempts were running.' } });
      } catch (error) {
        this.deps.log('error', 'Could not recover the attempts of a message', { session: this.deps.sessionId, message: (error as Error).message });
      }
    }
  }

  /** A rewind removed these messages: the checkouts of attempts on their cards go with them. */
  async forget(removed: StoredMessage[]): Promise<void> {
    for (const message of removed) {
      const set = message.meta.attempts;
      if (set && set.status !== 'applied' && set.status !== 'discarded') await this.removeCheckouts(set, null);
    }
  }
}
