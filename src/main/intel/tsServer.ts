import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import os from 'node:os';
import { isResponse, readFrames, writeRequest } from './tsProtocol';

export interface TsServerOptions {
  /** A TypeScript install's lib/tsserver.js. */
  tsserverPath: string;
  /** The program that runs it: Node, or Electron acting as Node. */
  execPath: string;
  /** Sets ELECTRON_RUN_AS_NODE, for when `execPath` is Electron. */
  runAsNode: boolean;
  /** Called once when the process ends, for whatever reason. */
  onExit(): void;
  log?(message: string): void;
}

interface Waiting {
  resolve(body: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One TypeScript server process and the requests waiting on it. The server
 * answers in the order it is asked, one request at a time, so a slow first
 * answer (it is loading the project) holds back the ones behind it.
 */
export class TsServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiting = new Map<number, Waiting>();
  private pending: Buffer = Buffer.alloc(0);
  private seq = 0;
  private ended = false;
  /** Whether any request has been answered yet: until then the server is still loading the project. */
  answered = false;

  constructor(private readonly options: TsServerOptions) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (options.runAsNode) env.ELECTRON_RUN_AS_NODE = '1';
    else delete env.ELECTRON_RUN_AS_NODE;
    // No typings installer: that would run npm and reach the network, which nothing here asked for.
    this.child = spawn(options.execPath, [options.tsserverPath, '--disableAutomaticTypingAcquisition', '--useInferredProjectPerProjectRoot', '--locale', 'en'], {
      // Not the project's folder: on Windows a running program's folder can't be renamed or deleted, and files are named in full anyway.
      cwd: os.homedir(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child.stdout.on('data', (chunk: Buffer) => this.read(chunk));
    // The server reports its own trouble on stderr; it is noted, never treated as an answer.
    this.child.stderr.on('data', (chunk: Buffer) => options.log?.(`tsserver: ${chunk.toString('utf8').trim().slice(0, 500)}`));
    this.child.stdin.on('error', () => this.end(new Error('The TypeScript server closed its input.')));
    this.child.on('error', (error) => this.end(error));
    this.child.on('exit', (code) => this.end(new Error(`The TypeScript server ended (exit ${String(code)}).`)));
  }

  get alive(): boolean {
    return !this.ended;
  }

  private read(chunk: Buffer): void {
    const { messages, rest } = readFrames(this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk);
    this.pending = rest;
    for (const message of messages) {
      if (!isResponse(message)) continue;
      const waiting = this.waiting.get(message.request_seq);
      if (!waiting) continue;
      this.waiting.delete(message.request_seq);
      clearTimeout(waiting.timer);
      this.answered = true;
      if (message.success) waiting.resolve(message.body);
      else waiting.reject(new Error(message.message ?? 'The TypeScript server refused the request.'));
    }
  }

  private end(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiting of this.waiting.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.waiting.clear();
    this.options.onExit();
  }

  /** Sends a command that gets no answer ("open", "close"). */
  notify(command: string, args: unknown): void {
    if (this.ended) return;
    this.child.stdin.write(writeRequest(++this.seq, command, args));
  }

  /** Sends a command and waits for its answer; rejects when the server ends, refuses, or takes longer than `timeoutMs`. */
  request(command: string, args: unknown, timeoutMs: number): Promise<unknown> {
    if (this.ended) return Promise.reject(new Error('The TypeScript server is not running.'));
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // The server may still answer; nobody waits for it any more.
        this.waiting.delete(seq);
        reject(new Error(`The TypeScript server did not answer "${command}" in ${String(timeoutMs)} ms.`));
      }, timeoutMs);
      this.waiting.set(seq, { resolve, reject, timer });
      this.child.stdin.write(writeRequest(seq, command, args));
    });
  }

  dispose(): void {
    if (this.ended) return;
    this.child.kill();
    this.end(new Error('The TypeScript server was shut down.'));
  }
}
