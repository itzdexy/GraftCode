import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ShellSpec } from './detect';
import { OutputBuffer, stripAnsi } from './outputBuffer';
import { runFile } from '../run';
import { execArgs, SANDBOX_WRAPPER, toContainerPath, toHostPath, type SandboxManager, type SandboxTarget } from '../../sandbox/sandbox';

export interface ShellRunOptions {
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  onOutput?: (chunk: string) => void;
}

export interface ShellRunResult {
  exitCode: number | null;
  output: string;
  truncated: boolean;
  logPath: string;
  durationMs: number;
  timedOut: boolean;
  interrupted: boolean;
  cwd: string;
}

export type BackgroundStatus = 'running' | 'exited' | 'killed' | 'failed';

export interface BackgroundShellInfo {
  id: string;
  sessionId: string;
  command: string;
  status: BackgroundStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  logPath: string;
}

interface SessionShellState {
  cwd: string;
  /** Variables set/changed by earlier commands (null = unset). */
  env: Map<string, string | null>;
  /** In the sandbox: the folder inside the container, which may have no counterpart here (e.g. /tmp). */
  boxCwd?: string;
}

interface Background extends BackgroundShellInfo {
  child: ChildProcess;
  closed: Promise<void>;
  text: string;
  dropped: number;
  readOffset: number;
  /** Stops the job and everything it started (inside the container for sandboxed jobs). */
  halt: () => Promise<void>;
}

/** How one command is started, stopped, and read back. */
interface Launch {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  pidFile: string | null;
  /** Files to delete once the command is over. */
  files: string[];
  /** Stops the command (and what it started) after `child` was spawned. */
  stop: (child: ChildProcess) => Promise<void>;
  /** Reads the folder (and on this computer, the variables) the command left behind. */
  capture: () => void;
}

const MAX_BACKGROUND_TEXT = 1_000_000;
/** Variables that change on every run or belong to the wrapper. */
const VOLATILE = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'PS1', 'PS2', 'PROMPT', 'COLUMNS', 'LINES']);

export const BASH_WRAPPER = [
  'echo $$ > "$GRAFT_STATE_PID" 2>/dev/null',
  'cd -- "$GRAFT_CWD" 2>/dev/null || echo "graft: working directory is missing: $GRAFT_CWD" >&2',
  '__graft_cmd=$GRAFT_CMD',
  'unset GRAFT_CMD GRAFT_CWD',
  'eval "$__graft_cmd"',
  '__graft_ec=$?',
  '{ pwd -W 2>/dev/null || pwd -P; } > "$GRAFT_STATE_CWD" 2>/dev/null',
  'env -0 > "$GRAFT_STATE_ENV" 2>/dev/null',
  'exit $__graft_ec'
].join('\n');

const POWERSHELL_WRAPPER = [
  "$ErrorActionPreference = 'Continue'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$OutputEncoding = [System.Text.Encoding]::UTF8',
  'try { Set-Location -LiteralPath $env:GRAFT_CWD -ErrorAction Stop } catch { [Console]::Error.WriteLine("graft: working directory is missing: $env:GRAFT_CWD") }',
  '$global:LASTEXITCODE = 0',
  '. $env:GRAFT_SCRIPT',
  '$__graftOk = $?',
  '$__graftEc = if ($LASTEXITCODE) { $LASTEXITCODE } elseif ($__graftOk) { 0 } else { 1 }',
  '(Get-Location).ProviderPath | Set-Content -LiteralPath $env:GRAFT_STATE_CWD -Encoding UTF8',
  'Get-ChildItem env: | ForEach-Object { "$($_.Name)=$($_.Value)" } | Set-Content -LiteralPath $env:GRAFT_STATE_ENV -Encoding UTF8',
  'exit $__graftEc'
].join('\n');

/** Environment for agent commands: no pagers, editors, prompts or colors that would hang or clutter output. */
export function agentEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    GRAFT: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CLICOLOR: '0',
    TERM: 'dumb'
  };
}

/** Directory holding Git for Windows' MSYS tools (ps.exe) for a bash path, if any. */
export function msysToolsDir(shellPath: string): string | null {
  const dir = path.dirname(shellPath);
  for (const candidate of [path.join(dir, '..', 'usr', 'bin'), dir]) {
    if (fs.existsSync(path.join(candidate, 'ps.exe'))) return path.normalize(candidate);
  }
  return null;
}

/**
 * Parses MSYS `ps` output and returns the Windows PIDs of the process group
 * led by rootPid plus all its logical descendants. MSYS fork/exec detaches
 * processes from the Windows parent chain, so `taskkill /T` alone misses them.
 */
export function msysTreeWinPids(psOutput: string, rootPid: number): number[] {
  const rows = psOutput
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .map((cols) => (cols[0] !== undefined && /^\d+$/.test(cols[0]) ? cols : cols.slice(1)))
    .filter((cols) => cols.length >= 4 && cols.slice(0, 4).every((c) => /^\d+$/.test(c)))
    .map((cols) => ({ pid: Number(cols[0]), ppid: Number(cols[1]), pgid: Number(cols[2]), winpid: Number(cols[3]) }));
  const pids = new Set<number>([rootPid]);
  for (const row of rows) if (row.pgid === rootPid) pids.add(row.pid);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (pids.has(row.ppid) && !pids.has(row.pid)) {
        pids.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.filter((r) => pids.has(r.pid)).map((r) => r.winpid);
}

function taskkill(pids: number[], tree: boolean): Promise<void> {
  if (pids.length === 0) return Promise.resolve();
  const args = [...pids.flatMap((pid) => ['/pid', String(pid)]), ...(tree ? ['/T'] : []), '/F'];
  // taskkill exits non-zero when some of the processes already ended; that outcome is expected here.
  return runFile('taskkill', args, { cwd: os.tmpdir(), timeoutMs: 15_000 }).then(() => undefined);
}

/**
 * Stops a command and everything it started. POSIX: signal the detached
 * process group, and once more, harder, after a grace period. Windows: kill
 * the launcher tree and, for Git Bash, every MSYS process in the wrapper's
 * group (found via ps.exe from the PID the wrapper recorded at start).
 *
 * The command itself is stopped whatever else goes wrong. When its descendants
 * could not be looked up, that is thrown afterwards: some may still be running,
 * and a partial cleanup must not read as a complete one.
 */
export async function killProcessTree(
  child: ChildProcess,
  options: { platform: NodeJS.Platform; msysTools: string | null; pidFile: string | null; onLateError?: (error: Error) => void }
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (options.platform !== 'win32') {
    const send = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-pid, sig);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };
    send('SIGTERM');
    // The shell usually dies at once; what it started may ignore the signal. So the second one goes to the
    // whole group whether or not its leader is still there. With nobody left in the group it does nothing.
    setTimeout(() => {
      try {
        send('SIGKILL');
      } catch (error) {
        options.onLateError?.(error as Error);
      }
    }, 2000).unref();
    return;
  }
  const winPids: number[] = [];
  let unlisted: Error | null = null;
  if (options.msysTools && options.pidFile) {
    const recorded = await fs.promises.readFile(options.pidFile, 'utf8').then(
      (t) => Number(t.trim()),
      () => Number.NaN
    );
    if (Number.isInteger(recorded) && recorded > 0) {
      const tool = path.join(options.msysTools, 'ps.exe');
      try {
        const ps = await runFile(tool, [], { cwd: os.tmpdir(), timeoutMs: 10_000 });
        winPids.push(...msysTreeWinPids(ps.stdout, recorded));
        if (ps.code !== 0) unlisted = new Error(`${tool} ended with ${ps.code === null ? 'a timeout' : `code ${String(ps.code)}`}`);
      } catch (error) {
        unlisted = new Error(`${tool} couldn't run: ${(error as Error).message}`);
      }
    }
  }
  try {
    await taskkill(winPids, false);
  } finally {
    await taskkill([pid], true);
  }
  if (unlisted) throw new Error(`Git Bash's processes couldn't be listed, so something the command started may still be running (${unlisted.message}).`);
}

/**
 * The folder a sandboxed command left, from the file it wrote in the shared
 * state folder. That folder is writable from the container, so the file may be
 * a planted link to a file on this computer: links are never followed, and only
 * a small regular file holding one absolute container path counts.
 */
export function readContainerCwd(file: string): string | null {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) return null;
    const text = fs.readFileSync(fd, 'utf8').trim();
    return /^\/[^\r\n\0]*$/.test(text) ? text : null;
  } finally {
    fs.closeSync(fd);
  }
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

/**
 * Runs agent shell commands with per-session persistent cwd and environment,
 * streamed output, timeouts, full logs on disk and background jobs. A session
 * with a sandbox target runs them in its container instead (see sandbox.ts).
 */
export class ShellManager extends EventEmitter {
  private readonly states = new Map<string, SessionShellState>();
  private readonly background = new Map<string, Background>();
  private readonly running = new Map<ChildProcess, string | null>();
  private readonly targets = new Map<string, SandboxTarget>();
  private readonly msysTools: string | null;

  constructor(
    readonly shell: ShellSpec,
    private readonly logDir: string,
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
    private readonly platform: NodeJS.Platform = process.platform,
    readonly sandbox: SandboxManager | null = null
  ) {
    super();
    this.msysTools = platform === 'win32' && shell.kind === 'bash' ? msysToolsDir(shell.path) : null;
  }

  /** Kills a child and everything it started; failures are reported as error-log events. */
  private stop(child: ChildProcess, pidFile: string | null): Promise<void> {
    const report = (error: Error): void => {
      this.emit('error-log', `Failed to stop process ${String(child.pid)}: ${error.message}`);
    };
    return killProcessTree(child, { platform: this.platform, msysTools: this.msysTools, pidFile, onLateError: report }).catch((error: unknown) => report(error as Error));
  }

  cwdFor(sessionId: string, fallback: string): string {
    const state = this.states.get(sessionId);
    if (state && fs.existsSync(state.cwd)) return state.cwd;
    return fallback;
  }

  resetSession(sessionId: string, cwd: string): void {
    this.states.set(sessionId, { cwd, env: new Map() });
  }

  /**
   * Runs a session's commands in a sandbox container (a target) or on this
   * computer (null). Switching between the two starts the shell over, since they
   * keep separate folders and variables. Turning the sandbox off removes the
   * container; changed settings get a fresh one with the next command.
   */
  async setSandbox(sessionId: string, target: SandboxTarget | null): Promise<void> {
    const next = target && this.sandbox ? target : null;
    const current = this.targets.get(sessionId) ?? null;
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    if (next) this.targets.set(sessionId, next);
    else this.targets.delete(sessionId);
    if ((current === null) !== (next === null)) this.states.delete(sessionId);
    if (!next) await this.sandbox?.remove(sessionId);
  }

  /** The sandbox a session's commands run in, or null when they run on this computer. */
  sandboxFor(sessionId: string): SandboxTarget | null {
    return this.targets.get(sessionId) ?? null;
  }

  private state(sessionId: string, fallbackCwd: string): SessionShellState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = { cwd: fallbackCwd, env: new Map() };
      this.states.set(sessionId, state);
    }
    if (!fs.existsSync(state.cwd)) state.cwd = fallbackCwd;
    return state;
  }

  private envKey(key: string): string {
    return this.platform === 'win32' ? key.toUpperCase() : key;
  }

  private launchEnv(state: SessionShellState, extra: Record<string, string>): NodeJS.ProcessEnv {
    const env = agentEnv(this.baseEnv);
    const keys = new Map(Object.keys(env).map((k) => [this.envKey(k), k]));
    for (const [key, value] of state.env) {
      const actual = keys.get(this.envKey(key)) ?? key;
      if (value === null) delete env[actual];
      else env[actual] = value;
    }
    return { ...env, ...extra };
  }

  private invocation(
    command: string,
    cwd: string,
    files: { cwd: string; env: string; script: string; pid: string }
  ): { file: string; args: string[]; extra: Record<string, string> } {
    const common = { GRAFT_STATE_CWD: files.cwd, GRAFT_STATE_ENV: files.env, GRAFT_STATE_PID: files.pid };
    if (this.shell.kind === 'powershell') {
      // UTF-8 with BOM so Windows PowerShell 5.1 reads non-ASCII correctly.
      fs.writeFileSync(files.script, `\ufeff${command}\n`, 'utf8');
      const encoded = Buffer.from(POWERSHELL_WRAPPER, 'utf16le').toString('base64');
      return {
        file: this.shell.path,
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        extra: { ...common, GRAFT_CWD: cwd, GRAFT_SCRIPT: files.script }
      };
    }
    const flags = this.shell.kind === 'bash' ? ['--noprofile', '--norc'] : this.shell.kind === 'zsh' ? ['-f'] : [];
    return {
      file: this.shell.path,
      args: [...flags, '-c', BASH_WRAPPER],
      extra: { ...common, GRAFT_CWD: this.platform === 'win32' ? cwd.replace(/\\/g, '/') : cwd, GRAFT_CMD: command }
    };
  }

  /** A command on this computer, through the user's shell. `save` keeps the folder and variables it leaves. */
  private hostLaunch(state: SessionShellState, command: string, dir: string, id: string, save: boolean): Launch {
    const files = {
      cwd: path.join(dir, `${id}.cwd`),
      env: path.join(dir, `${id}.env`),
      script: path.join(dir, `${id}.ps1`),
      pid: path.join(dir, `${id}.pid`)
    };
    const { file, args, extra } = this.invocation(command, state.cwd, files);
    const env = this.launchEnv(state, extra);
    return {
      file,
      args,
      env,
      cwd: state.cwd,
      pidFile: files.pid,
      files: Object.values(files),
      stop: (child) => this.stop(child, files.pid),
      capture: () => {
        if (save) this.captureState(state, files, env);
      }
    };
  }

  /** A command in the session's sandbox container, which is created (and its image downloaded) first when needed. */
  private async sandboxLaunch(
    sandbox: SandboxManager,
    sessionId: string,
    target: SandboxTarget,
    state: SessionShellState,
    command: string,
    run: { dir: string; id: string; save: boolean; progress: (text: string) => void; signal: AbortSignal }
  ): Promise<Launch> {
    const stateDir = path.join(run.dir, 'sandbox');
    const box = await sandbox.ensure(sessionId, target, stateDir, run.progress, run.signal);
    const boxCwd = state.boxCwd ?? toContainerPath(state.cwd, target.workspace, this.platform);
    const cwdFile = path.join(stateDir, `${run.id}.cwd`);
    return {
      file: box.engine.path,
      args: execArgs(box.name, ['GRAFT_CMD', 'GRAFT_CWD', 'GRAFT_ID', 'GRAFT_SAVE'], SANDBOX_WRAPPER),
      env: sandbox.cliEnv({ GRAFT_CMD: command, GRAFT_CWD: boxCwd, GRAFT_ID: run.id, GRAFT_SAVE: run.save ? '1' : '0' }),
      cwd: fs.existsSync(state.cwd) ? state.cwd : os.homedir(),
      pidFile: null,
      files: [cwdFile, path.join(stateDir, `${run.id}.pid`)],
      // Killing the CLI would leave the command running in the container: stop it there first.
      stop: async (child) => {
        await sandbox.kill(sessionId, run.id);
        await this.stop(child, null);
      },
      capture: () => {
        if (!run.save) return;
        // Null when the command exited the shell before writing it (e.g. `exit`): keep the previous folder.
        const raw = readContainerCwd(cwdFile);
        if (!raw) return;
        state.boxCwd = raw;
        const host = toHostPath(raw, target.workspace, this.platform);
        if (host && fs.existsSync(host)) state.cwd = host;
      }
    };
  }

  /** Where the session's shell is now, as a folder on this computer when it has one (e.g. not /tmp in the sandbox). */
  private shownCwd(state: SessionShellState, target: SandboxTarget | undefined): string {
    if (!target || !state.boxCwd) return state.cwd;
    return toHostPath(state.boxCwd, target.workspace, this.platform) ?? state.boxCwd;
  }

  /** Runs one foreground command and resolves when it exits, times out or is interrupted. */
  async run(sessionId: string, command: string, options: ShellRunOptions): Promise<ShellRunResult> {
    const state = this.state(sessionId, options.cwd);
    const id = `${Date.now()}-${randomUUID().slice(0, 6)}`;
    const dir = path.join(this.logDir, safeName(sessionId));
    await fs.promises.mkdir(dir, { recursive: true });
    const logPath = path.join(dir, `${id}.log`);
    const target = this.sandbox ? this.targets.get(sessionId) : undefined;
    const started = Date.now();
    let launch: Launch;
    try {
      launch =
        target && this.sandbox
          ? await this.sandboxLaunch(this.sandbox, sessionId, target, state, command, {
              dir,
              id,
              save: true,
              progress: (text) => options.onOutput?.(text),
              signal: options.signal
            })
          : this.hostLaunch(state, command, dir, id, true);
    } catch (error) {
      // The sandbox couldn't start (no engine, a failed download…): report it like a command that failed.
      const message = `${(error as Error).message}\n`;
      await fs.promises.writeFile(logPath, `$ ${command}\n${message}`);
      return {
        exitCode: null,
        output: message,
        truncated: false,
        logPath,
        durationMs: Date.now() - started,
        timedOut: false,
        interrupted: options.signal.aborted,
        cwd: this.shownCwd(state, target)
      };
    }
    const log = fs.createWriteStream(logPath);
    log.write(`$ ${command}\n`);
    const buffer = new OutputBuffer();
    let timedOut = false;
    let interrupted = false;

    const child = spawn(launch.file, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: this.platform !== 'win32'
    });
    this.running.set(child, launch.pidFile);
    const decoders = { out: new TextDecoder(), err: new TextDecoder() };
    let pending = '';
    let flushTimer: NodeJS.Timeout | undefined;
    const flush = (): void => {
      flushTimer = undefined;
      if (pending.length > 0 && options.onOutput) options.onOutput(pending);
      pending = '';
    };
    const onData = (which: 'out' | 'err') => (chunk: Buffer) => {
      log.write(chunk);
      const text = stripAnsi(decoders[which].decode(chunk, { stream: true }));
      buffer.append(text);
      pending += text;
      flushTimer ??= setTimeout(flush, 80);
    };
    child.stdout?.on('data', onData('out'));
    child.stderr?.on('data', onData('err'));

    const timer = setTimeout(() => {
      timedOut = true;
      void launch.stop(child);
    }, options.timeoutMs);
    const onAbort = (): void => {
      interrupted = true;
      void launch.stop(child);
    };
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('error', (error) => {
        buffer.append(`\nFailed to start ${target ? 'the sandbox' : this.shell.label}: ${error.message}\n`);
        resolve(null);
      });
      // A background child can keep the output pipes open after the command
      // itself exits; don't wait on it forever.
      let grace: NodeJS.Timeout | undefined;
      child.on('exit', (code) => {
        grace = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          resolve(code);
        }, 2000);
      });
      child.on('close', (code) => {
        clearTimeout(grace);
        resolve(code);
      });
    });
    clearTimeout(timer);
    options.signal.removeEventListener('abort', onAbort);
    this.running.delete(child);
    clearTimeout(flushTimer);
    for (const d of Object.values(decoders)) buffer.append(stripAnsi(d.decode()));
    flush();
    await new Promise<void>((resolve) => log.end(resolve));

    launch.capture();
    for (const f of launch.files) await fs.promises.rm(f, { force: true });

    return {
      exitCode,
      output: buffer.text(logPath),
      truncated: buffer.truncated,
      logPath,
      durationMs: Date.now() - started,
      timedOut,
      interrupted,
      cwd: this.shownCwd(state, target)
    };
  }

  private captureState(state: SessionShellState, files: { cwd: string; env: string }, launched: NodeJS.ProcessEnv): void {
    try {
      const rawCwd = fs.readFileSync(files.cwd, 'utf8').replace(/^\ufeff/, '').trim();
      if (rawCwd.length > 0) {
        const next = this.platform === 'win32' ? path.win32.normalize(rawCwd) : rawCwd;
        if (fs.existsSync(next)) state.cwd = next;
      }
    } catch (error) {
      // The command exited the shell before state was written (e.g. `exit`); keep the previous cwd.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(files.env, 'utf8').replace(/^\ufeff/, '');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return;
    }
    const entries = this.shell.kind === 'powershell' ? raw.split(/\r?\n/) : raw.split('\0');
    const after = new Map<string, [string, string]>();
    for (const entry of entries) {
      const eq = entry.indexOf('=', 1);
      if (eq <= 0) continue;
      const key = entry.slice(0, eq);
      after.set(this.envKey(key), [key, entry.slice(eq + 1)]);
    }
    const before = new Map(Object.entries(launched).map(([k, v]) => [this.envKey(k), [k, v ?? ''] as [string, string]]));
    const skip = (key: string): boolean => VOLATILE.has(key.toUpperCase()) || key.toUpperCase().startsWith('GRAFT_');
    for (const [nk, [key, value]] of after) {
      if (skip(key)) continue;
      const prior = before.get(nk);
      if (prior && prior[1] === value) continue;
      // Git Bash rewrites Windows path lists (C:\… → /c/…); those aren't user changes.
      if (this.platform === 'win32' && prior && /^[A-Za-z]:\\/.test(prior[1]) && value.startsWith('/')) continue;
      state.env.set(key, value);
    }
    for (const [nk, [key]] of before) {
      if (!after.has(nk) && !skip(key) && after.size > 0) state.env.set(key, null);
    }
  }

  /**
   * Starts a command without waiting; poll with readOutput. In the sandbox this
   * waits for the container first (`progress` hears about a first download).
   */
  async startBackground(
    sessionId: string,
    command: string,
    cwdFallback: string,
    options: { progress?: (text: string) => void; signal?: AbortSignal } = {}
  ): Promise<BackgroundShellInfo> {
    const state = this.state(sessionId, cwdFallback);
    const id = `bg-${randomUUID().slice(0, 8)}`;
    const dir = path.join(this.logDir, safeName(sessionId));
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, `${id}.log`);
    const target = this.sandbox ? this.targets.get(sessionId) : undefined;
    const launch =
      target && this.sandbox
        ? await this.sandboxLaunch(this.sandbox, sessionId, target, state, command, {
            dir,
            id,
            save: false,
            progress: options.progress ?? (() => undefined),
            signal: options.signal ?? new AbortController().signal
          })
        : this.hostLaunch(state, command, dir, id, false);
    const child = spawn(launch.file, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: this.platform !== 'win32'
    });
    const log = fs.createWriteStream(logPath);
    log.write(`$ ${command}\n`);
    let markClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const job: Background = {
      id,
      sessionId,
      command,
      status: 'running',
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      logPath,
      child,
      closed,
      text: '',
      dropped: 0,
      readOffset: 0,
      halt: () => launch.stop(child)
    };
    this.background.set(id, job);
    const decoder = new TextDecoder();
    const onData = (chunk: Buffer): void => {
      log.write(chunk);
      job.text += stripAnsi(decoder.decode(chunk, { stream: true }));
      if (job.text.length > MAX_BACKGROUND_TEXT) {
        const cut = job.text.length - MAX_BACKGROUND_TEXT;
        job.text = job.text.slice(cut);
        job.dropped += cut;
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (error) => {
      job.text += `\nFailed to start: ${error.message}\n`;
      job.status = 'failed';
      job.endedAt = Date.now();
      markClosed();
      this.emit('change', sessionId);
    });
    child.on('close', (code) => {
      log.end();
      for (const f of launch.files) {
        fs.rm(f, { force: true }, (error) => {
          if (error) this.emit('error-log', `Could not remove ${f}: ${error.message}`);
        });
      }
      if (job.status === 'running') job.status = 'exited';
      job.exitCode = code;
      job.endedAt = Date.now();
      markClosed();
      this.emit('change', sessionId);
    });
    this.emit('change', sessionId);
    return this.info(job);
  }

  private info(job: Background): BackgroundShellInfo {
    const { id, sessionId, command, status, exitCode, startedAt, endedAt, logPath } = job;
    return { id, sessionId, command, status, exitCode, startedAt, endedAt, logPath };
  }

  /** Output produced since the previous read, optionally filtered by a regex. */
  readOutput(id: string, filter?: RegExp): { info: BackgroundShellInfo; output: string; skipped: number } | null {
    const job = this.background.get(id);
    if (!job) return null;
    const absoluteEnd = job.dropped + job.text.length;
    const start = Math.max(job.readOffset, job.dropped);
    const skipped = start - job.readOffset;
    let output = job.text.slice(start - job.dropped);
    job.readOffset = absoluteEnd;
    if (filter) output = output.split(/\r?\n/).filter((l) => filter.test(l)).join('\n');
    return { info: this.info(job), output, skipped };
  }

  /** Stops a background job and resolves once it has exited (or after 5s). */
  async kill(id: string): Promise<boolean> {
    const job = this.background.get(id);
    if (!job || job.status !== 'running') return false;
    job.status = 'killed';
    this.emit('change', job.sessionId);
    await job.halt();
    await Promise.race([job.closed, new Promise<void>((resolve) => setTimeout(resolve, 5000).unref())]);
    return true;
  }

  list(sessionId?: string): BackgroundShellInfo[] {
    return [...this.background.values()]
      .filter((j) => sessionId === undefined || j.sessionId === sessionId)
      .map((j) => this.info(j))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  clearFinished(sessionId: string): number {
    let removed = 0;
    for (const [id, job] of this.background) {
      if (job.sessionId === sessionId && job.status !== 'running') {
        this.background.delete(id);
        removed++;
      }
    }
    if (removed > 0) this.emit('change', sessionId);
    return removed;
  }

  /** Kills everything a session started (session closed or deleted), its sandbox container included. */
  async disposeSession(sessionId: string): Promise<void> {
    const jobs = [...this.background.values()].filter((j) => j.sessionId === sessionId);
    await Promise.all(jobs.map((j) => this.kill(j.id)));
    this.states.delete(sessionId);
    this.targets.delete(sessionId);
    await this.sandbox?.remove(sessionId);
  }

  async disposeAll(): Promise<void> {
    const jobs = [...this.background.values()].map((j) => this.kill(j.id));
    const foreground = [...this.running].map(([child, pidFile]) => this.stop(child, pidFile));
    await Promise.all([...jobs, ...foreground]);
    await this.sandbox?.removeAll();
  }
}
