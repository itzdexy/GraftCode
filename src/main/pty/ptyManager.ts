import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
import { GraftError } from '@shared/errors';
import { MarkScanner } from '@shared/terminalMarks';
import { runFile } from '../tools/run';
import type { ShellSpec } from '../tools/shell/detect';
import { msysToolsDir, msysTreeWinPids } from '../tools/shell/shellManager';
import { shellLaunch, writeLaunchFiles, type ShellLaunch } from './shellIntegration';

/** Scrollback kept per terminal so a reopened panel shows recent output. */
const SCROLLBACK_BYTES = 256 * 1024;
/** Output is batched for this long before it is sent to the renderer. */
const FLUSH_MS = 16;
const MAX_TERMINALS_PER_SESSION = 8;

export interface TerminalInfo {
  id: string;
  sessionId: string;
  title: string;
  cwd: string;
  exitCode: number | null;
  exited: boolean;
}

interface Terminal {
  info: TerminalInfo;
  proc: pty.IPty;
  scrollback: string;
  /** Characters of output produced so far (stream offset of the next chunk). */
  total: number;
  pending: string;
  /** Stream offset where `pending` starts. */
  pendingAt: number;
  timer: NodeJS.Timeout | null;
  /** Reads the folder the shell says it is in from its marks (shellIntegration.ts). */
  marks: MarkScanner;
}

export interface PtyEvents {
  /** `offset` is the stream position of the chunk's first character (lets a viewer merge with a snapshot). */
  data(id: string, data: string, offset: number): void;
  exit(id: string, exitCode: number): void;
  log(message: string): void;
}

/** Interactive shell arguments for a terminal tab (the agent's Shell tool runs commands differently). */
export function interactiveArgs(shell: ShellSpec): string[] {
  if (shell.kind === 'powershell') return ['-NoLogo'];
  if (shell.kind === 'sh') return ['-i'];
  return ['--login', '-i'];
}

/**
 * Real pseudo-terminals for the Terminal panel. Each belongs to a session and
 * starts in its folder; output is batched and also kept as scrollback.
 */
export class PtyManager {
  private readonly terminals = new Map<string, Terminal>();
  private readonly msysTools: string | null;

  constructor(
    private readonly shell: ShellSpec,
    private readonly events: PtyEvents,
    private readonly platform: NodeJS.Platform = process.platform,
    /** Where the shell integration's files are written; null starts every shell plainly. */
    private readonly integrationDir: string | null = null
  ) {
    this.msysTools = platform === 'win32' && shell.kind === 'bash' ? msysToolsDir(shell.path) : null;
  }

  create(sessionId: string, cwd: string, cols: number, rows: number): TerminalInfo {
    const count = [...this.terminals.values()].filter((t) => t.info.sessionId === sessionId && !t.info.exited).length;
    if (count >= MAX_TERMINALS_PER_SESSION) throw new GraftError('too_many_terminals', `Close a terminal first (at most ${MAX_TERMINALS_PER_SESSION} per session).`);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    // Electron's own variables must not leak into user shells.
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    env.TERM_PROGRAM = 'Graft';
    if (this.shell.kind === 'bash' && this.platform === 'win32') env.CHERE_INVOKING = '1';
    const launch = this.launch(env);
    const proc = pty.spawn(this.shell.path, launch?.args ?? interactiveArgs(this.shell), {
      name: 'xterm-256color',
      cols: Math.max(2, cols),
      rows: Math.max(1, rows),
      cwd,
      env: { ...env, ...launch?.env }
    });
    const info: TerminalInfo = { id: randomUUID(), sessionId, title: this.shell.label, cwd, exitCode: null, exited: false };
    const term: Terminal = { info, proc, scrollback: '', total: 0, pending: '', pendingAt: 0, timer: null, marks: new MarkScanner() };
    this.terminals.set(info.id, term);
    proc.onData((data) => this.onData(term, data));
    proc.onExit(({ exitCode }) => {
      this.flush(term);
      term.info.exited = true;
      term.info.exitCode = exitCode;
      this.events.exit(info.id, exitCode);
    });
    return { ...info };
  }

  /** The shell's start with Graft's marks, or null to start it plainly (a shell without them, or files that couldn't be written). */
  private launch(env: Record<string, string>): ShellLaunch | null {
    if (!this.integrationDir) return null;
    const launch = shellLaunch(this.shell, this.integrationDir, env, this.platform);
    if (!launch) return null;
    try {
      writeLaunchFiles(this.integrationDir, launch.files);
      return launch;
    } catch (error) {
      this.events.log(`The terminal starts without shell integration: ${(error as Error).message}`);
      return null;
    }
  }

  private onData(term: Terminal, data: string): void {
    for (const mark of term.marks.scan(data)) if (mark.kind === 'cwd') term.info.cwd = mark.path;
    if (term.pending.length === 0) term.pendingAt = term.total;
    term.pending += data;
    term.total += data.length;
    term.scrollback = (term.scrollback + data).slice(-SCROLLBACK_BYTES);
    term.timer ??= setTimeout(() => this.flush(term), FLUSH_MS);
  }

  private flush(term: Terminal): void {
    if (term.timer) clearTimeout(term.timer);
    term.timer = null;
    if (term.pending.length === 0) return;
    const data = term.pending;
    term.pending = '';
    this.events.data(term.info.id, data, term.pendingAt);
  }

  private require(id: string, sessionId?: string): Terminal {
    const term = this.terminals.get(id);
    if (!term || (sessionId !== undefined && term.info.sessionId !== sessionId)) throw new GraftError('terminal_not_found', 'That terminal is closed.');
    return term;
  }

  write(id: string, data: string): void {
    const term = this.require(id);
    if (!term.info.exited) term.proc.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const term = this.require(id);
    if (!term.info.exited) term.proc.resize(Math.max(2, cols), Math.max(1, rows));
  }

  /** The shell a terminal of this session runs and the folder it last said it was in, for a command written for it. */
  shellOf(id: string, sessionId: string): { shell: ShellSpec; cwd: string } {
    return { shell: this.shell, cwd: this.require(id, sessionId).info.cwd };
  }

  list(sessionId: string): TerminalInfo[] {
    return [...this.terminals.values()].filter((t) => t.info.sessionId === sessionId).map((t) => ({ ...t.info }));
  }

  /** Recent output and the stream offset it ends at. */
  snapshot(id: string): { data: string; end: number } {
    const term = this.require(id);
    return { data: term.scrollback, end: term.total };
  }

  async kill(id: string): Promise<void> {
    const term = this.require(id);
    this.terminals.delete(id);
    if (term.timer) clearTimeout(term.timer);
    if (term.info.exited) return;
    await this.killTree(term);
  }

  /** Stops the shell and what it started (MSYS processes are outside the Windows parent chain). */
  private async killTree(term: Terminal): Promise<void> {
    const pid = term.proc.pid;
    if (this.platform !== 'win32') {
      term.proc.kill('SIGHUP');
      return;
    }
    const winPids: number[] = [];
    if (this.msysTools) {
      try {
        const ps = await runFile(path.join(this.msysTools, 'ps.exe'), [], { cwd: os.tmpdir(), timeoutMs: 10_000 });
        const row = ps.stdout
          .split(/\r?\n/)
          .map((line) => line.trim().split(/\s+/))
          .map((cols) => (cols[0] !== undefined && /^\d+$/.test(cols[0]) ? cols : cols.slice(1)))
          .find((cols) => Number(cols[3]) === pid);
        if (row?.[0]) winPids.push(...msysTreeWinPids(ps.stdout, Number(row[0])));
      } catch (error) {
        this.events.log(`Could not list terminal processes: ${(error as Error).message}`);
      }
    }
    const targets = [...new Set([...winPids, pid])];
    // taskkill reports a failure for processes that already exited; that outcome is expected.
    await runFile('taskkill', [...targets.flatMap((p) => ['/pid', String(p)]), '/T', '/F'], { cwd: os.tmpdir(), timeoutMs: 15_000 });
    try {
      term.proc.kill();
    } catch (error) {
      // The console host is usually gone already after taskkill.
      this.events.log(`Terminal ${term.info.id} was already closed: ${(error as Error).message}`);
    }
  }

  async disposeSession(sessionId: string): Promise<void> {
    const ids = [...this.terminals.values()].filter((t) => t.info.sessionId === sessionId).map((t) => t.info.id);
    await Promise.all(ids.map((id) => this.kill(id)));
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.terminals.keys()].map((id) => this.kill(id)));
  }
}
