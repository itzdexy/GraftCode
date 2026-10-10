import fs from 'node:fs';
import path from 'node:path';
import { toLocations, toReferences, type CodeLocation, type CodeReference } from './navigation';
import { MAX_PROBLEMS, toProblems, type FileProblems } from './problems';
import { TsServer } from './tsServer';

/** TypeScript and JavaScript sources, module flavours included. */
const CHECKABLE = /\.[cm]?[jt]sx?$/i;

/** Whether a language server here can check this file. */
export function isCheckable(file: string): boolean {
  return CHECKABLE.test(file);
}

/**
 * The TypeScript server a project brings for `file`: the nearest
 * node_modules/typescript at or above the file's folder, inside the project.
 * One above the project root is not looked at: the project is the folder the
 * user trusted, and what lies outside it is someone else's code.
 */
export function findTypeScript(file: string, projectRoot: string): string | null {
  const root = path.resolve(projectRoot);
  let dir = path.dirname(path.resolve(file));
  const inside = (candidate: string): boolean => {
    const rel = path.relative(root, candidate);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  while (inside(dir)) {
    const candidate = path.join(dir, 'node_modules', 'typescript', 'lib', 'tsserver.js');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface CodeIntelOptions {
  /** The program that runs a server: Node, or Electron acting as Node (`runAsNode`). */
  execPath: string;
  runAsNode: boolean;
  /** Finds the server for a file; findTypeScript unless a test brings its own. */
  typescriptFor?(file: string, projectRoot: string): string | null;
  /** How long an edit waits for a server that is still loading its project, and for one that has answered before. */
  firstAnswerMs?: number;
  answerMs?: number;
  /** A server nobody asked anything for this long is shut down. */
  idleMs?: number;
  log?(message: string): void;
}

interface Running {
  server: TsServer;
  idle: ReturnType<typeof setTimeout> | null;
}

/**
 * Code intelligence from the project's own language server. Today that is
 * TypeScript's: after an edit, the errors of the edited file come back with
 * the edit's result, so a type error is fixed in the next step instead of
 * surfacing in a build later.
 *
 * A server is the project's code running on this computer, so the caller
 * asks only for a project the user trusts and whose commands are not kept in
 * a sandbox. One server runs for each TypeScript install and project; it
 * starts with the first question and stops when left idle.
 */
export class CodeIntel {
  private readonly servers = new Map<string, Running>();
  private disposed = false;

  constructor(private readonly options: CodeIntelOptions) {}

  private serverFor(tsserverPath: string, projectRoot: string): TsServer {
    const key = `${tsserverPath}\u0000${projectRoot}`;
    let running = this.servers.get(key);
    if (!running) {
      const entry: Running = {
        idle: null,
        server: new TsServer({
          tsserverPath,
          execPath: this.options.execPath,
          runAsNode: this.options.runAsNode,
          log: (message) => this.options.log?.(message),
          onExit: () => {
            if (entry.idle) clearTimeout(entry.idle);
            if (this.servers.get(key) === entry) this.servers.delete(key);
          }
        })
      };
      running = entry;
      this.servers.set(key, running);
    }
    if (running.idle) clearTimeout(running.idle);
    const live = running;
    running.idle = setTimeout(() => live.server.dispose(), this.options.idleMs ?? 10 * 60_000);
    // A timer alone must not keep the app from quitting.
    running.idle.unref?.();
    return running.server;
  }

  /**
   * Opens `file` in the project's server with its text from disk, asks, and
   * closes it again, so the server goes back to following the file on disk (a
   * formatter or git may change it next). Null when there is no server for the
   * file, or it gave no answer in time.
   */
  private async withOpen<T>(file: string, projectRoot: string, ask: (server: TsServer, name: string, wait: number) => Promise<T>): Promise<T | null> {
    if (this.disposed || !isCheckable(file)) return null;
    const tsserverPath = (this.options.typescriptFor ?? findTypeScript)(file, projectRoot);
    if (!tsserverPath) return null;
    let content: string;
    try {
      content = await fs.promises.readFile(file, 'utf8');
    } catch {
      return null;
    }
    const name = file.replace(/\\/g, '/');
    try {
      const server = this.serverFor(tsserverPath, projectRoot);
      const wait = server.answered ? (this.options.answerMs ?? 5_000) : (this.options.firstAnswerMs ?? 10_000);
      // Opened with the text just read, so the answer is about this version whatever the server last saw.
      server.notify('open', { file: name, fileContent: content, projectRootPath: projectRoot.replace(/\\/g, '/') });
      try {
        return await ask(server, name, wait);
      } finally {
        server.notify('close', { file: name });
      }
    } catch (error) {
      this.options.log?.(`The language server gave no answer about ${name}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * The errors in `file` as it is on disk now. Null when nothing can say:
   * not a file a server checks, no TypeScript in the project, the server is
   * still loading and the wait ran out, or it failed. Null is never "no
   * problems": a file found clean comes back with an empty list.
   */
  problems(file: string, projectRoot: string): Promise<FileProblems | null> {
    return this.withOpen(file, projectRoot, async (server, name, wait) => {
      const syntax = toProblems(await server.request('syntacticDiagnosticsSync', { file: name }, wait));
      // With the syntax broken, what the checker says about types is noise.
      const all = syntax.length > 0 ? syntax : toProblems(await server.request('semanticDiagnosticsSync', { file: name }, wait));
      return { source: 'TypeScript', problems: all.slice(0, MAX_PROBLEMS), total: all.length };
    });
  }

  /** Where the symbol at this place in `file` is defined; null when the server cannot say. */
  definition(file: string, line: number, column: number, projectRoot: string): Promise<CodeLocation[] | null> {
    return this.withOpen(file, projectRoot, async (server, name, wait) => toLocations(await server.request('definition', { file: name, line, offset: column }, wait)));
  }

  /** Every use of the symbol at this place in `file`, across the project, its definition among them; null when the server cannot say. */
  references(file: string, line: number, column: number, projectRoot: string): Promise<CodeReference[] | null> {
    return this.withOpen(file, projectRoot, async (server, name, wait) => toReferences(await server.request('references', { file: name, line, offset: column }, wait)));
  }

  /** Stops every server. Nothing is answered afterwards. */
  dispose(): void {
    this.disposed = true;
    for (const running of [...this.servers.values()]) {
      if (running.idle) clearTimeout(running.idle);
      running.server.dispose();
    }
    this.servers.clear();
  }
}
