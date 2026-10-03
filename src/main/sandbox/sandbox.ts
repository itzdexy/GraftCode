import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeDirSync } from '../files/makeDir';
import { runFile } from '../tools/run';
import { engineProblem, probeEngine, type ContainerEngine, type EngineProbe } from './engine';

/**
 * The sandbox: a container per session that runs the session's commands.
 * Only the project folder is mounted (at /workspace). The commands get none of
 * this computer's environment variables, files or credentials; .git and .graft
 * are mounted read-only so nothing in the container can plant a git hook,
 * fsmonitor command or Graft hook that would later run outside it.
 */

export const CONTAINER_WORKSPACE = '/workspace';
export const CONTAINER_STATE = '/graft-state';
/** Folders in the project the container may read but never change. */
export const READ_ONLY_DIRS = ['.git', '.graft'];
/** Ports dev servers usually take; each is forwarded to a free port on this computer (localhost only). */
export const FORWARDED_PORTS = [3000, 3001, 4173, 4200, 4321, 5000, 5173, 8000, 8080, 8888];

export interface SandboxSettings {
  image: string;
  /** Internet access for installs and downloads; off cuts the container off entirely. */
  network: boolean;
  memoryMb: number;
  cpus: number;
}

export interface SandboxTarget {
  /** The folder mounted at /workspace: the session's project, or its worktree. */
  workspace: string;
  settings: SandboxSettings;
}

/** Image references as Docker writes them; never starting with "-", so one can't pass for a flag. */
export const IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/:@-]{0,299}$/i;

/** Same variables host commands get: no pagers, editors, prompts or colors. */
const SANDBOX_ENV: Record<string, string> = {
  GRAFT: '1',
  GRAFT_SANDBOX: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  CLICOLOR: '0',
  TERM: 'dumb',
  // The mounted repository can belong to another user id; git would refuse to read it.
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'safe.directory',
  GIT_CONFIG_VALUE_0: '*'
};

/** Runs the wrapper with bash when the image has it (agents write bash), else sh. `$0` is the wrapper. */
export const LAUNCH = 'if command -v bash >/dev/null 2>&1; then exec bash --noprofile --norc -c "$0"; fi; exec sh -c "$0"';

/**
 * Runs one command inside the container. The command, its folder and its id
 * arrive as environment variables. Environment changes are kept inside the
 * container (env.sh in the state folder) rather than sent back: nothing the
 * container prints can reach the Docker CLI's own environment on this computer.
 */
export const SANDBOX_WRAPPER = [
  `if [ -f ${CONTAINER_STATE}/env.sh ]; then . ${CONTAINER_STATE}/env.sh >/dev/null 2>&1; fi`,
  `echo $$ > "${CONTAINER_STATE}/$GRAFT_ID.pid"`,
  'if [ -n "$HOME" ] && [ ! -d "$HOME" ]; then mkdir -p "$HOME" 2>/dev/null; fi',
  `cd -- "$GRAFT_CWD" 2>/dev/null || { echo "graft: working directory is missing: $GRAFT_CWD" >&2; cd ${CONTAINER_WORKSPACE}; }`,
  '__graft_cmd=$GRAFT_CMD',
  '__graft_id=$GRAFT_ID',
  '__graft_save=$GRAFT_SAVE',
  'unset GRAFT_CMD GRAFT_CWD GRAFT_ID GRAFT_SAVE',
  'eval "$__graft_cmd"',
  '__graft_ec=$?',
  'if [ "$__graft_save" = 1 ]; then',
  `  pwd -P > "${CONTAINER_STATE}/$__graft_id.cwd" 2>/dev/null`,
  `  export -p > "${CONTAINER_STATE}/env.sh.$__graft_id" 2>/dev/null && mv -f "${CONTAINER_STATE}/env.sh.$__graft_id" ${CONTAINER_STATE}/env.sh`,
  'fi',
  'exit $__graft_ec'
].join('\n');

/**
 * Stops a command and everything it started, using only /proc and shell
 * builtins so it works in any image. Each process is frozen first, so it can't
 * carry on (or start more) while its children are killed; children die before
 * their parent, because once the parent is gone they belong to init and can no
 * longer be found.
 */
export const KILL_SCRIPT = [
  'kt() {',
  '  kill -STOP "$1" 2>/dev/null',
  '  for d in /proc/[0-9]*; do',
  '    pp=',
  '    while read -r k v; do if [ "$k" = PPid: ]; then pp=$v; break; fi; done 2>/dev/null < "$d/status"',
  '    if [ "$pp" = "$1" ]; then kt "${d#/proc/}"; fi',
  '  done',
  '  kill -9 "$1" 2>/dev/null',
  '}',
  `if read -r p 2>/dev/null < "${CONTAINER_STATE}/$GRAFT_ID.pid"; then kt "$p"; fi`
].join('\n');

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Where a folder on this computer is inside the container; folders outside the project map to /workspace. */
export function toContainerPath(hostPath: string, workspace: string, platform: NodeJS.Platform): string {
  const api = pathApi(platform);
  const rel = api.relative(workspace, hostPath);
  if (rel === '') return CONTAINER_WORKSPACE;
  if (rel.startsWith('..') || api.isAbsolute(rel)) return CONTAINER_WORKSPACE;
  return `${CONTAINER_WORKSPACE}/${rel.split(api.sep).join('/')}`;
}

/** The folder on this computer for a container path, or null when it isn't in the project. */
export function toHostPath(containerPath: string, workspace: string, platform: NodeJS.Platform): string | null {
  const normal = path.posix.normalize(containerPath.trim());
  if (normal === CONTAINER_WORKSPACE || normal === `${CONTAINER_WORKSPACE}/`) return workspace;
  if (!normal.startsWith(`${CONTAINER_WORKSPACE}/`)) return null;
  const parts = normal.slice(CONTAINER_WORKSPACE.length + 1).split('/').filter((p) => p.length > 0);
  return pathApi(platform).join(workspace, ...parts);
}

/** A container name for a session: Docker allows [a-zA-Z0-9][a-zA-Z0-9_.-]. */
export function containerName(sessionId: string): string {
  return `graft-${sessionId.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 48)}`;
}

/** A per-project volume for node_modules, so installs in the sandbox never touch the copy on this computer. */
export function nodeModulesVolume(workspace: string): string {
  return `graft-node-modules-${createHash('sha256').update(workspace.toLowerCase()).digest('hex').slice(0, 16)}`;
}

/** One --mount value. Docker reads it as CSV, so a field with a comma or quote is quoted. */
export function mountValue(fields: Array<[string, string] | string>): string {
  return fields
    .map((f) => (typeof f === 'string' ? f : `${f[0]}=${f[1]}`))
    .map((f) => (/[",]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f))
    .join(',');
}

export interface RunPlan {
  name: string;
  sessionId: string;
  target: SandboxTarget;
  stateDir: string;
  engine: Pick<ContainerEngine, 'kind' | 'cpus' | 'rootless'>;
  platform: NodeJS.Platform;
  /** The user's id on Linux, where a rootful engine would otherwise leave root-owned files in the project. */
  hostUser: { uid: number; gid: number } | null;
  /** Read-only folders that exist in this project (relative). */
  readOnly: string[];
  hasPackageJson: boolean;
}

/** Whether the container runs as the user (Linux with a rootful engine) instead of as root. */
export function runsAsUser(plan: Pick<RunPlan, 'platform' | 'engine' | 'hostUser'>): boolean {
  return plan.platform === 'linux' && !plan.engine.rootless && plan.hostUser !== null;
}

/** Arguments for `docker run` that create a session's container. */
export function runArgs(plan: RunPlan): string[] {
  const { target } = plan;
  const settings = target.settings;
  const asUser = runsAsUser(plan);
  const cpus = Math.min(settings.cpus, plan.engine.cpus);
  const mounts: string[] = [
    mountValue([['type', 'bind'], ['source', target.workspace], ['target', CONTAINER_WORKSPACE]]),
    ...plan.readOnly.map((rel) =>
      mountValue([['type', 'bind'], ['source', pathApi(plan.platform).join(target.workspace, rel)], ['target', `${CONTAINER_WORKSPACE}/${rel}`], 'readonly'])
    ),
    mountValue([['type', 'bind'], ['source', plan.stateDir], ['target', CONTAINER_STATE]])
  ];
  // As the user, a fresh volume would be root's and unwritable; the project's own folder is fine there.
  if (plan.hasPackageJson && !asUser) {
    mounts.push(mountValue([['type', 'volume'], ['source', nodeModulesVolume(target.workspace)], ['target', `${CONTAINER_WORKSPACE}/node_modules`]]));
  }
  const env = { ...SANDBOX_ENV, ...(asUser ? { HOME: '/tmp/home' } : {}) };
  return [
    'run',
    '--detach',
    '--name',
    plan.name,
    '--init',
    '--label',
    'graft.app=graft',
    '--label',
    `graft.session=${plan.sessionId}`,
    '--hostname',
    'sandbox',
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'NET_RAW',
    '--cap-drop',
    'MKNOD',
    '--cap-drop',
    'AUDIT_WRITE',
    '--pids-limit',
    '1024',
    '--memory',
    `${settings.memoryMb}m`,
    '--cpus',
    String(cpus),
    ...mounts.flatMap((m) => ['--mount', m]),
    '--workdir',
    CONTAINER_WORKSPACE,
    ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    ...(asUser && plan.hostUser ? ['--user', `${plan.hostUser.uid}:${plan.hostUser.gid}`] : []),
    ...(settings.network ? FORWARDED_PORTS.flatMap((p) => ['--publish', `127.0.0.1::${p}`]) : ['--network', 'none']),
    '--entrypoint',
    'sh',
    settings.image,
    '-c',
    'trap "exit 0" TERM INT; while :; do sleep 3600 & wait $!; done'
  ];
}

/** Arguments for `docker exec` that run a command. Values travel in the CLI's environment (-e NAME), never in argv. */
export function execArgs(name: string, vars: string[], script: string): string[] {
  return ['exec', ...vars.flatMap((v) => ['--env', v]), name, 'sh', '-c', LAUNCH, script];
}

/** Parses `docker port` output ("5173/tcp -> 127.0.0.1:49153") into container port → host port. */
export function parsePorts(output: string): Record<number, number> {
  const out: Record<number, number> = {};
  for (const line of output.split(/\r?\n/)) {
    const m = /^(\d+)\/tcp\s*->\s*(?:\[[^\]]*\]|[\d.]+|[^:\s]*):(\d+)\s*$/.exec(line.trim());
    if (m) out[Number(m[1])] ??= Number(m[2]);
  }
  return out;
}

/**
 * A localhost address as seen from inside the sandbox, rewritten to the port
 * this computer forwards to it. Addresses for other hosts, or ports the
 * sandbox doesn't forward, come back unchanged.
 */
export function sandboxUrl(raw: string, ports: Record<number, number>): string {
  const input = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `http://${raw.trim()}`;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return raw;
  }
  if (!['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(url.hostname)) return raw;
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const hostPort = ports[port];
  if (!hostPort) return raw;
  url.hostname = '127.0.0.1';
  url.port = String(hostPort);
  return url.toString();
}

export class SandboxError extends Error {}

interface Box {
  name: string;
  key: string;
  engine: ContainerEngine;
  ports: Record<number, number>;
  checkedAt: number;
}

export interface SandboxManagerOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  log: (level: 'info' | 'warn', message: string, fields?: Record<string, string | number | boolean>) => void;
  /** Tests swap the engine probe. */
  probe?: () => Promise<EngineProbe>;
}

const RECHECK_MS = 15_000;
const PULL_TIMEOUT_MS = 30 * 60_000;

export class SandboxManager {
  private readonly boxes = new Map<string, Box>();
  private readonly pending = new Map<string, Promise<Box>>();
  private probed: { at: number; probe: EngineProbe } | null = null;
  private orphansCleared = false;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: SandboxManagerOptions) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
  }

  /** The engine, re-probed every so often (people start Docker after Graft). */
  async probe(force = false): Promise<EngineProbe> {
    const fresh = this.probed && Date.now() - this.probed.at < (this.probed.probe.status === 'ready' ? 60_000 : 5_000);
    if (fresh && !force && this.probed) return this.probed.probe;
    const probe = await (this.options.probe ?? (() => probeEngine(this.platform, this.env)))();
    this.probed = { at: Date.now(), probe };
    return probe;
  }

  private async engine(): Promise<ContainerEngine> {
    const probe = await this.probe();
    if (probe.status === 'ready') return probe.engine;
    throw new SandboxError(engineProblem(probe, this.platform) ?? 'The sandbox is unavailable.');
  }

  /** Environment for the engine's CLI: this computer's own, never anything a command set. */
  cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { ...this.env, ...extra };
  }

  private run(engine: ContainerEngine, args: string[], timeoutMs = 60_000, signal?: AbortSignal) {
    return runFile(engine.path, args, { cwd: os.homedir(), timeoutMs, env: this.cliEnv(), ...(signal ? { signal } : {}) });
  }

  /** The running container for a session, created (and its image pulled) when needed. */
  async ensure(sessionId: string, target: SandboxTarget, stateDir: string, progress: (line: string) => void, signal: AbortSignal): Promise<Box> {
    const key = JSON.stringify(target);
    const existing = this.boxes.get(sessionId);
    if (existing && existing.key === key && Date.now() - existing.checkedAt < RECHECK_MS) return existing;
    // One creation at a time per session: a background start and a command can race here.
    const inflight = this.pending.get(sessionId);
    if (inflight) return inflight;
    const work = this.prepare(sessionId, target, key, stateDir, progress, signal).finally(() => this.pending.delete(sessionId));
    this.pending.set(sessionId, work);
    return work;
  }

  private async prepare(sessionId: string, target: SandboxTarget, key: string, stateDir: string, progress: (line: string) => void, signal: AbortSignal): Promise<Box> {
    const engine = await this.engine();
    if (!IMAGE_PATTERN.test(target.settings.image)) throw new SandboxError(`"${target.settings.image}" isn't a valid image name.`);
    const name = containerName(sessionId);
    const existing = this.boxes.get(sessionId);
    if (existing && existing.key === key) {
      const state = await this.run(engine, ['inspect', '--format', '{{.State.Running}}', name], 20_000);
      if (state.code === 0 && state.stdout.trim() === 'true') {
        existing.checkedAt = Date.now();
        return existing;
      }
      this.options.log('info', 'Sandbox container stopped; starting a new one', { session: sessionId });
    }
    if (!this.orphansCleared) {
      this.orphansCleared = true;
      await this.removeOrphans(engine);
    }
    // Settings changed, or the container died: start over with a fresh one.
    await this.run(engine, ['rm', '--force', name], 30_000);
    this.boxes.delete(sessionId);

    await this.pull(engine, target.settings.image, progress, signal);
    fs.mkdirSync(stateDir, { recursive: true });
    // Environment saved by commands in an earlier container doesn't belong to this one.
    fs.rmSync(path.join(stateDir, 'env.sh'), { force: true });
    // Mount points for the read-only folders have to exist, or the container could create them itself.
    const graftDir = path.join(target.workspace, '.graft');
    makeDirSync(graftDir);
    const readOnly = READ_ONLY_DIRS.filter((rel) => fs.existsSync(path.join(target.workspace, rel)));
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    const gid = typeof process.getgid === 'function' ? process.getgid() : -1;
    const args = runArgs({
      name,
      sessionId,
      target,
      stateDir,
      engine,
      platform: this.platform,
      hostUser: uid >= 0 && gid >= 0 ? { uid, gid } : null,
      readOnly,
      hasPackageJson: fs.existsSync(path.join(target.workspace, 'package.json'))
    });
    progress(`Starting the sandbox (${target.settings.image})…\n`);
    const created = await this.run(engine, args, 120_000, signal);
    if (created.code !== 0) {
      throw new SandboxError(`Couldn't start the sandbox: ${(created.stderr.trim() || created.stdout.trim()).split(/\r?\n/).slice(-4).join(' ')}`);
    }
    const ports = target.settings.network ? parsePorts((await this.run(engine, ['port', name], 20_000)).stdout) : {};
    const box: Box = { name, key, engine, ports, checkedAt: Date.now() };
    this.boxes.set(sessionId, box);
    this.options.log('info', 'Sandbox started', { session: sessionId, image: target.settings.image, engine: engine.kind, network: target.settings.network });
    return box;
  }

  private async pull(engine: ContainerEngine, image: string, progress: (line: string) => void, signal: AbortSignal): Promise<void> {
    const present = await this.run(engine, ['image', 'inspect', '--format', '{{.Id}}', image], 30_000);
    if (present.code === 0) return;
    progress(`Downloading ${image}. This happens once and can take a few minutes…\n`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(engine.path, ['pull', image], { cwd: os.homedir(), env: this.cliEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let tail = '';
      const onData = (chunk: Buffer): void => {
        const text = chunk.toString('utf8');
        tail = (tail + text).slice(-2000);
        progress(text);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const timer = setTimeout(() => child.kill(), PULL_TIMEOUT_MS);
      const onAbort = (): void => {
        child.kill();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', (error) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(new SandboxError(`Couldn't download ${image}: ${error.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) reject(new SandboxError('Stopped while downloading the sandbox image.'));
        else if (code === 0) resolve();
        else reject(new SandboxError(`Couldn't download ${image}: ${tail.trim().split(/\r?\n/).slice(-3).join(' ')}`));
      });
    });
  }

  /** Whether an image is on this computer already; null when no engine is running. */
  async imageReady(image: string): Promise<boolean | null> {
    const probe = await this.probe();
    if (probe.status !== 'ready' || !IMAGE_PATTERN.test(image)) return null;
    const present = await this.run(probe.engine, ['image', 'inspect', '--format', '{{.Id}}', image], 30_000);
    return present.code === 0;
  }

  /** Downloads an image ahead of time (Settings → Sandbox), so a session's first command doesn't wait for it. */
  async pullImage(image: string, signal: AbortSignal): Promise<void> {
    const engine = await this.engine();
    if (!IMAGE_PATTERN.test(image)) throw new SandboxError(`"${image}" isn't a valid image name.`);
    await this.pull(engine, image, () => undefined, signal);
  }

  /** Stops a command running in a session's container, with everything it started. */
  async kill(sessionId: string, id: string): Promise<void> {
    const box = this.boxes.get(sessionId);
    if (!box) return;
    const result = await runFile(box.engine.path, ['exec', '--env', 'GRAFT_ID', box.name, 'sh', '-c', KILL_SCRIPT], {
      cwd: os.homedir(),
      timeoutMs: 20_000,
      env: this.cliEnv({ GRAFT_ID: id })
    }).catch((error: unknown) => ({ code: null, stdout: '', stderr: (error as Error).message }));
    if (result.code !== 0) this.options.log('warn', 'Could not stop a sandboxed command', { session: sessionId, detail: result.stderr.slice(0, 300) });
  }

  /** The container a session runs in, if it has one. */
  box(sessionId: string): { name: string; engine: ContainerEngine; ports: Record<number, number> } | null {
    const box = this.boxes.get(sessionId);
    return box ? { name: box.name, engine: box.engine, ports: box.ports } : null;
  }

  /** Removes a session's container (the session closed, or its sandbox was turned off). */
  async remove(sessionId: string): Promise<void> {
    const box = this.boxes.get(sessionId);
    if (!box) return;
    this.boxes.delete(sessionId);
    const result = await this.run(box.engine, ['rm', '--force', box.name], 30_000).catch((error: unknown) => ({ code: null, stdout: '', stderr: (error as Error).message }));
    if (result.code !== 0) this.options.log('warn', 'Could not remove a sandbox container', { name: box.name, detail: result.stderr.slice(0, 300) });
  }

  /** Removes every container this run started (the app is quitting). */
  async removeAll(): Promise<void> {
    const boxes = [...this.boxes.values()];
    this.boxes.clear();
    const byEngine = new Map<string, { engine: ContainerEngine; names: string[] }>();
    for (const b of boxes) {
      const entry = byEngine.get(b.engine.path) ?? { engine: b.engine, names: [] };
      entry.names.push(b.name);
      byEngine.set(b.engine.path, entry);
    }
    await Promise.all([...byEngine.values()].map(({ engine, names }) => this.run(engine, ['rm', '--force', ...names], 30_000).catch(() => undefined)));
  }

  /** Containers left behind by a run that didn't quit cleanly. */
  private async removeOrphans(engine: ContainerEngine): Promise<void> {
    const listed = await this.run(engine, ['ps', '--all', '--quiet', '--filter', 'label=graft.app=graft'], 20_000);
    const ids = listed.stdout.split(/\s+/).filter((id) => /^[a-f0-9]{6,}$/i.test(id));
    if (ids.length === 0) return;
    await this.run(engine, ['rm', '--force', ...ids], 60_000);
    this.options.log('info', 'Removed leftover sandbox containers', { count: ids.length });
  }

  /**
   * Removes the cached node_modules volumes (Settings → Sandbox → Free up space).
   * One at a time: a volume a running sandbox uses stays, and the rest still go.
   */
  async removeVolumes(): Promise<number> {
    const engine = await this.engine();
    const listed = await this.run(engine, ['volume', 'ls', '--quiet', '--filter', 'name=graft-node-modules-'], 20_000);
    const names = listed.stdout.split(/\s+/).filter((n) => /^graft-node-modules-[a-f0-9]+$/.test(n));
    let removed = 0;
    for (const name of names) {
      const result = await this.run(engine, ['volume', 'rm', name], 60_000);
      if (result.code === 0) removed++;
    }
    return removed;
  }
}
