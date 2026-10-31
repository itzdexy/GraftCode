import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CancellationTokenSource, createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/node';
import { z } from 'zod';
import { GraftError } from '@shared/errors';
import { looksBinary } from '../tools/fs/read';
import { runFile } from '../tools/run';
import { renameEdits } from './rename';
import type { CodeLocation, SemanticQuery, SemanticResult } from './types';

const Position = z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() });
const Range = z.object({ start: Position, end: Position });
const Location = z.object({ uri: z.string(), range: Range });
const LocationLink = z.object({ targetUri: z.string(), targetSelectionRange: Range });
const TsDiagnosticResponse = z.object({ body: z.array(z.object({ message: z.string(), category: z.string(), code: z.number(),
  startLocation: z.object({ line: z.number().int().positive(), offset: z.number().int().positive() }) })).max(50_000) });

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validatedFile(root: string, name: string): string {
  const file = fs.realpathSync(path.resolve(root, name));
  if (!within(root, file)) throw new GraftError('language_path', 'Semantic queries must stay within the project, including symlink targets.');
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file)) throw new GraftError('language_unsupported', 'Semantic queries currently support TypeScript and JavaScript files. Use Symbols or Grep for other languages.');
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new GraftError('language_file_limit', 'Semantic files must be regular files no larger than 2 MiB.');
  return file;
}

/** Where `name` stands as a whole word in `text` at or after `from`; -1 when it does not. */
function wordAt(text: string, name: string, from: number): number {
  for (let at = text.indexOf(name, from); at !== -1; at = text.indexOf(name, at + 1)) {
    if (!/[\w$]/.test(text[at - 1] ?? ' ') && !/[\w$]/.test(text[at + name.length] ?? ' ')) return at;
  }
  return -1;
}

function languageId(file: string): string {
  return /\.tsx$/i.test(file) ? 'typescriptreact' : /\.[cm]?ts$/i.test(file) ? 'typescript' : /\.jsx$/i.test(file) ? 'javascriptreact' : 'javascript';
}

/** The most files one rename changes; each is given to the server, which holds 64 documents. */
const MAX_RENAME_FILES = 50;

/** A file's state on disk, to tell whether it changed since the server was given its text; null when it is not there. */
function diskStamp(file: string): string | null {
  try { const stat = fs.statSync(file); return `${String(stat.mtimeMs)}:${String(stat.size)}`; }
  catch { return null; }
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      abort = () => reject(new GraftError('interrupted', 'Semantic query cancelled.'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

/** Actual files on disk are needed by Electron's Node child and by tsserver. */
function unpacked(id: string): string {
  const resolved = require.resolve(id);
  const disk = resolved.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return fs.existsSync(disk) ? disk : resolved;
}

function serverEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
  const allowed = new Set(['path', 'systemroot', 'windir', 'temp', 'tmp', 'tmpdir', 'home', 'userprofile', 'lang', 'lc_all']);
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key.toLowerCase())) env[key] = value;
  return env;
}

class TypeScriptClient {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly connection: MessageConnection;
  private readonly ready: Promise<void>;
  private readonly exited: Promise<void>;
  /** The documents the server holds open, by URI: the version it was last given, and the file's state on disk then (null for an unsaved buffer). */
  private readonly documents = new Map<string, { version: number; file: string; stamp: string | null }>();
  private tail: Promise<unknown> = Promise.resolve();
  /** Queries the mouse asked for (hovers) still waiting their turn: any other query drops them. One already running is quick and finishes. */
  private readonly waiting = new Set<AbortController>();
  private closed = false;
  private disposing: Promise<void> | undefined;
  active = 0;
  touched = Date.now();

  constructor(readonly root: string) {
    this.child = spawn(process.execPath, [unpacked('typescript-language-server/lib/cli.mjs'), '--stdio', '--log-level', '1'],
      { cwd: root, env: serverEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', () => undefined); // drain; project source/diagnostics never enter application logs
    this.exited = new Promise((resolve) => this.child.once('close', () => resolve()));
    this.connection = createMessageConnection(this.child.stdout, this.child.stdin);
    // This client offers read queries only: server-driven writes/commands are rejected.
    this.connection.onRequest('workspace/applyEdit', () => ({ applied: false, failureReason: 'Semantic queries cannot write files.' }));
    this.connection.onRequest('workspace/configuration', () => []);
    this.connection.onRequest('client/registerCapability', () => null);
    this.connection.onClose(() => { this.closed = true; });
    this.child.on('error', () => { this.closed = true; this.connection.dispose(); });
    this.connection.listen();
    this.ready = this.request('initialize', {
      processId: process.pid, rootUri: pathToFileURL(root).href,
      workspaceFolders: [{ uri: pathToFileURL(root).href, name: path.basename(root) }],
      capabilities: { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true }, rename: { prepareSupport: true } } },
      initializationOptions: { hostInfo: 'Graft', disableAutomaticTypingAcquisition: true, maxTsServerMemory: 256,
        plugins: [], tsserver: { path: unpacked('typescript/lib/tsserver.js'), useSyntaxServer: 'never' } }
    }).then(async () => { await this.connection.sendNotification('initialized', {}); });
    // Avoid unhandled initialization rejection if a queued caller cancels before starting.
    void this.ready.catch(() => undefined);
  }

  get alive(): boolean { return !this.closed && this.child.exitCode === null && !this.child.killed; }

  private async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const token = new CancellationTokenSource();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        onAbort = () => { token.cancel(); reject(new GraftError('interrupted', 'Semantic query cancelled.')); };
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => { token.cancel(); reject(new GraftError('language_server_timeout', `Language server timed out during ${method}. Retry after reducing the project scope.`)); }, 20_000);
      });
      return await Promise.race([this.connection.sendRequest(method, params, token.token), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      token.dispose();
    }
  }

  run(input: SemanticQuery, signal: AbortSignal, buffer?: string, background = false): Promise<SemanticResult> {
    let own: AbortController | undefined;
    if (background) {
      own = new AbortController();
      this.waiting.add(own);
      signal = AbortSignal.any([signal, own.signal]);
    } else {
      for (const hover of this.waiting) hover.abort();
    }
    this.active++;
    const operation = this.tail.then(async () => {
      if (own) this.waiting.delete(own);
      signal.throwIfAborted();
      await abortable(this.ready, signal);
      signal.throwIfAborted();
      if (!this.alive) throw new GraftError('language_server_closed', 'Language server exited. Retry to start a new process.');
      const bufferUri = buffer === undefined ? null : pathToFileURL(validatedFile(this.root, input.file)).href;
      try { return await this.query(input, signal, buffer); }
      finally {
        // A checked draft must not become the contents of another agent's disk query.
        if (bufferUri && this.documents.has(bufferUri)) {
          this.documents.delete(bufferUri);
          if (this.alive) await this.connection.sendNotification('textDocument/didClose', { textDocument: { uri: bufferUri } }).catch(() => undefined);
        }
      }
    });
    this.tail = operation.catch(() => undefined);
    return abortable(operation.finally(() => { this.active--; this.touched = Date.now(); if (own) this.waiting.delete(own); }), signal);
  }

  private location(uri: string, position: z.infer<typeof Position>): CodeLocation | null {
    try {
      const file = fs.realpathSync(fileURLToPath(uri));
      return within(this.root, file) ? { file: path.relative(this.root, file).replaceAll(path.sep, '/'), line: position.line + 1, column: position.character + 1 } : null;
    } catch { return null; }
  }

  /**
   * Where a declaration's name is. The server says where the declaration starts ("export" in `export function
   * twice`); the next question, who uses it, is asked on the name. The start itself when the name is not found.
   */
  private nameStart(texts: Map<string, string[]>, declared: z.infer<typeof Location>, name: string): z.infer<typeof Position> {
    const { start, end } = declared.range;
    try {
      let lines = texts.get(declared.uri);
      if (!lines) { lines = fs.readFileSync(validatedFile(this.root, fileURLToPath(declared.uri)), 'utf8').split(/\r\n|\n|\r/); texts.set(declared.uri, lines); }
      // A name stands near the start of its declaration; a long body is not searched for it.
      for (let line = start.line; line <= Math.min(end.line, start.line + 20); line++) {
        const at = wordAt(lines[line] ?? '', name, line === start.line ? start.character : 0);
        if (at !== -1) return { line, character: at };
      }
    } catch { /* not a file this client reads: the declaration's start has to do */ }
    return start;
  }

  /**
   * The server answers from the documents it holds, not from the disk. One whose file changed since it was given
   * (a command, the user's editor, a rewind) is given again, and one whose file is gone or no longer fit to hold
   * is closed, so no file is checked against an old copy of what it imports.
   */
  private async refresh(queried: string): Promise<void> {
    for (const [uri, held] of this.documents) {
      if (uri === queried) continue;
      const stamp = diskStamp(held.file);
      if (stamp === held.stamp) continue;
      let text: string | null = null;
      try { if (validatedFile(this.root, held.file) === held.file) text = fs.readFileSync(held.file, 'utf8'); }
      catch { /* closed below: the server then reads whatever is on disk itself */ }
      if (text === null) {
        this.documents.delete(uri);
        await this.connection.sendNotification('textDocument/didClose', { textDocument: { uri } });
      } else {
        this.documents.set(uri, { version: held.version + 1, file: held.file, stamp });
        await this.connection.sendNotification('textDocument/didChange', { textDocument: { uri, version: held.version + 1 }, contentChanges: [{ text }] });
      }
    }
  }

  private async query(input: SemanticQuery, signal: AbortSignal, buffer?: string): Promise<SemanticResult> {
    const file = validatedFile(this.root, input.file);
    // Taken before the text is read: a write in between shows as a change at the next query instead of being missed.
    const stamp = buffer === undefined ? diskStamp(file) : null;
    const text = buffer ?? fs.readFileSync(file, 'utf8');
    const uri = await this.give(file, text, stamp);
    await this.refresh(uri);
    const base: SemanticResult = { engine: 'typescript-language-server', action: input.action, file: path.relative(this.root, file).replaceAll(path.sep, '/'), truncated: false };
    if (input.action === 'diagnostics') {
      // This pinned server does not version publishDiagnostics. Its documented LSP
      // command extension waits for synchronous diagnostics after the current didChange.
      // Never turn a missing/invalid response into an empty "clean" result.
      const diagnostics: NonNullable<SemanticResult['diagnostics']> = [];
      for (const command of ['syntacticDiagnosticsSync', 'semanticDiagnosticsSync', 'suggestionDiagnosticsSync']) {
        const raw = await this.request('workspace/executeCommand', { command: 'typescript.tsserverRequest',
          arguments: [command, { file, includeLinePosition: true }, { isAsync: false }] }, signal);
        const parsed = TsDiagnosticResponse.safeParse(raw);
        if (!parsed.success) throw new GraftError('language_diagnostics', 'The server did not return current diagnostics; no clean result is claimed.');
        for (const d of parsed.data.body) {
          if (diagnostics.length >= 500) { base.truncated = true; break; }
          diagnostics.push({ file: base.file, line: d.startLocation.line, column: d.startLocation.offset,
            severity: d.category === 'error' ? 1 : d.category === 'warning' ? 2 : d.category === 'suggestion' ? 4 : 3,
            code: d.code, message: d.message.slice(0, 4000) });
        }
      }
      return { ...base, diagnostics };
    }
    if (input.action === 'outline') {
      const raw = await this.request('textDocument/documentSymbol', { textDocument: { uri } }, signal);
      const symbols: NonNullable<SemanticResult['symbols']> = [];
      const walk = (items: unknown[], depth = 0): void => {
        if (depth > 50) { base.truncated = true; return; }
        for (const item of items) {
          if (symbols.length >= 500) { base.truncated = true; return; }
          const parsed = z.object({ name: z.string(), kind: z.number(), selectionRange: Range.optional(), location: Location.optional(), children: z.array(z.unknown()).optional() }).safeParse(item);
          if (!parsed.success) continue;
          const symbol = parsed.data;
          const range = symbol.selectionRange ?? symbol.location?.range;
          const loc = range ? this.location(symbol.location?.uri ?? uri, range.start) : null;
          if (loc) symbols.push({ ...loc, name: symbol.name.slice(0, 300), kind: symbol.kind });
          if (symbol.children) walk(symbol.children, depth + 1);
        }
      };
      if (Array.isArray(raw)) walk(raw);
      return { ...base, symbols };
    }
    if (input.action === 'symbol') {
      if (!input.name) throw new GraftError('language_name', 'Give the name to find.');
      // The server searches the project of the document it was given last, which is the one just opened.
      const raw = await this.request('workspace/symbol', { query: input.name }, signal);
      const found: NonNullable<SemanticResult['symbols']> = [];
      const texts = new Map<string, string[]>();
      for (const item of Array.isArray(raw) ? raw : []) {
        const parsed = z.object({ name: z.string(), kind: z.number(), containerName: z.string().optional(), location: Location }).safeParse(item);
        if (!parsed.success) continue;
        const symbol = parsed.data;
        const loc = this.location(symbol.location.uri, this.nameStart(texts, symbol.location, symbol.name));
        // The project's own declarations: what its packages declare is not where the work is.
        if (!loc || /(?:^|\/)node_modules\//.test(loc.file)) continue;
        found.push({ ...loc, name: symbol.name.slice(0, 300), kind: symbol.kind, ...(symbol.containerName ? { container: symbol.containerName.slice(0, 300) } : {}) });
      }
      // The name as asked comes before the names that only begin with it or contain it.
      const exact = (symbol: { name: string }): number => (symbol.name === input.name ? 0 : 1);
      found.sort((a, b) => exact(a) - exact(b));
      return { ...base, symbols: found.slice(0, 200), truncated: found.length > 200 };
    }
    if (!input.line || !input.column) throw new GraftError('language_position', 'Give a 1-based line and column for definition, references, implementation, typeDefinition or hover.');
    const lines = text.split(/\r\n|\n|\r/);
    if (input.line > lines.length || input.column > (lines[input.line - 1]?.length ?? 0) + 1) throw new GraftError('language_position', 'The line or column is outside the current file. Read the current file and retry.');
    if (input.action === 'rename') return { ...base, ...(await this.rename({ ...input, line: input.line, column: input.column }, file, lines, signal)) };
    const raw = await this.request(`textDocument/${input.action}`, { textDocument: { uri }, position: { line: input.line - 1, character: input.column - 1 }, ...(input.action === 'references' ? { context: { includeDeclaration: true } } : {}) }, signal);
    if (input.action === 'hover') {
      const hover = z.object({ contents: z.union([z.string(), z.object({ value: z.string() }), z.array(z.union([z.string(), z.object({ value: z.string() })]))]) }).safeParse(raw);
      const contents = hover.success ? hover.data.contents : '';
      const value = (Array.isArray(contents) ? contents : [contents]).map((c) => typeof c === 'string' ? c : c.value).join('\n\n');
      return { ...base, hover: value.slice(0, 16_000), truncated: value.length > 16_000 };
    }
    const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const locations: CodeLocation[] = [];
    for (const item of items.slice(0, 1000)) {
      const loc = Location.safeParse(item), link = LocationLink.safeParse(item);
      const decoded = loc.success ? this.location(loc.data.uri, loc.data.range.start) : link.success ? this.location(link.data.targetUri, link.data.targetSelectionRange.start) : null;
      if (decoded) locations.push(decoded);
    }
    return { ...base, locations, truncated: items.length > 1000 };
  }

  /**
   * Gives the server a file's text: opened when it does not hold the file yet (the oldest other document makes room,
   * never `keep`), changed when it does. `stamp` is the file on disk then, null for an unsaved buffer.
   */
  private async give(file: string, text: string, stamp: string | null, keep?: string): Promise<string> {
    const uri = pathToFileURL(file).href;
    if (!this.documents.has(uri) && this.documents.size >= 64) {
      const oldest = [...this.documents.keys()].find((held) => held !== keep);
      if (oldest) { await this.connection.sendNotification('textDocument/didClose', { textDocument: { uri: oldest } }); this.documents.delete(oldest); }
    }
    const version = (this.documents.get(uri)?.version ?? 0) + 1;
    this.documents.set(uri, { version, file, stamp });
    if (version === 1) await this.connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: languageId(file), version, text } });
    else await this.connection.sendNotification('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    return uri;
  }

  /** The project file a URI names, relative and "/"-separated, or null outside the project or in its packages. */
  private projectFile(uri: string): string | null {
    const found = this.location(uri, { line: 0, character: 0 });
    return found && !/(?:^|\/)node_modules\//.test(found.file) ? found.file : null;
  }

  /**
   * Renaming the name at a position of `file` (its text, `lines`, is what the server holds). Without a new name the
   * answer is only where the name is. With one, the server is asked once to learn which files change; each of those
   * is then given to it as it is on disk now and it is asked again, so every edit fits the bytes its revision names.
   */
  private async rename(input: SemanticQuery & { line: number; column: number }, file: string, lines: string[], signal: AbortSignal): Promise<Pick<SemanticResult, 'span' | 'edits'>> {
    const uri = pathToFileURL(file).href;
    const position = { line: input.line - 1, character: input.column - 1 };
    let prepared: unknown;
    try { prepared = await this.request('textDocument/prepareRename', { textDocument: { uri }, position }, signal); }
    catch (error) {
      // The server says why a name cannot be renamed (a keyword, something a library declares).
      if (error instanceof GraftError) throw error;
      throw new GraftError('language_rename', error instanceof Error && error.message ? error.message : 'This name cannot be renamed.');
    }
    const range = Range.safeParse(prepared).data ?? z.object({ range: Range }).safeParse(prepared).data?.range;
    if (!range) throw new GraftError('language_rename', 'There is no name to rename here. Put the cursor on a name and try again.');
    if (!input.newName) {
      const text = range.start.line === range.end.line ? (lines[range.start.line] ?? '').slice(range.start.character, range.end.character) : '';
      return { span: { line: range.start.line + 1, column: range.start.character + 1, endLine: range.end.line + 1, endColumn: range.end.character + 1, text } };
    }
    const newName = input.newName;
    const ask = async (): Promise<ReturnType<typeof renameEdits>> =>
      renameEdits(await this.request('textDocument/rename', { textDocument: { uri }, position, newName }, signal), (target) => this.projectFile(target));
    const own = path.relative(this.root, file).replaceAll(path.sep, '/');
    const first = await ask();
    if (first.size > MAX_RENAME_FILES) throw new GraftError('language_rename', `This rename changes ${String(first.size)} files, more than the editor renames at once. Ask the agent to make it.`);
    const revisions = new Map<string, string>();
    for (const rel of first.keys()) {
      if (rel === own) continue;
      const target = path.join(this.root, rel);
      const stamp = diskStamp(target);
      const bytes = fs.readFileSync(target);
      const text = bytes.toString('utf8');
      if (bytes.length > 2 * 1024 * 1024 || looksBinary(bytes) || !Buffer.from(text, 'utf8').equals(bytes)) {
        throw new GraftError('language_rename', `${rel} is not UTF-8 text of 2 MiB or less, so the rename cannot change it.`);
      }
      await this.give(target, text, stamp, uri);
      revisions.set(rel, createHash('sha256').update(bytes).digest('hex'));
    }
    const edits = revisions.size ? await ask() : first;
    return {
      edits: [...edits].map(([rel, list]) => {
        if (rel === own) return { file: rel, revision: null, edits: list };
        const revision = revisions.get(rel);
        if (!revision) throw new GraftError('language_rename', 'The project changed while the rename was worked out, so nothing was changed. Rename again.');
        return { file: rel, revision, edits: list };
      })
    };
  }

  dispose(): Promise<void> {
    return this.disposing ??= this.close();
  }

  private async close(): Promise<void> {
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
    if (!this.closed) {
      try {
        await Promise.race([this.connection.sendRequest('shutdown'), new Promise((resolve) => { shutdownTimer = setTimeout(resolve, 1000); })]);
        // On Windows, keep the wrapper alive until its tree has been stopped.
        // Once exit closes the wrapper, taskkill can no longer find tsserver's
        // parent chain, and its inherited project cwd can remain locked.
        if (process.platform !== 'win32') await this.connection.sendNotification('exit');
      }
      catch { /* a dead server still needs local transport cleanup */ }
      finally { if (shutdownTimer) clearTimeout(shutdownTimer); }
    }
    this.closed = true;
    if (process.platform === 'win32' && this.child.pid !== undefined && this.child.exitCode === null && this.child.signalCode === null) {
      const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
      try {
        await runFile(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(this.child.pid), '/T', '/F'],
          { cwd: os.tmpdir(), timeoutMs: 3000, maxBuffer: 16 * 1024, env: serverEnvironment() });
      } catch { /* Still close our direct child if the system utility is unavailable. */ }
    }
    this.connection.dispose();
    // Killing is asynchronous. Do not resolve just because kill() was requested:
    // close confirms process exit and stdio cleanup before callers release files.
    if (!await this.waitForExit(2000)) {
      this.child.kill();
      if (!await this.waitForExit(2000)) throw new GraftError('language_server_close_timeout', 'Language server did not exit after shutdown.');
    }
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.exited.then(() => true), new Promise<boolean>((resolve) => {
        exitTimer = setTimeout(() => resolve(false), timeoutMs);
      })]);
    }
    finally { if (exitTimer) clearTimeout(exitTimer); }
  }
}

/** Bounded, on-demand local LSP processes; each project/private writer gets separate documents. */
export class LanguageServers {
  private readonly clients = new Map<string, TypeScriptClient>();
  private readonly closing = new Set<Promise<void>>();
  private disposed = false;
  private readonly idle: ReturnType<typeof setInterval>;
  constructor() {
    this.idle = setInterval(() => {
      for (const [root, client] of this.clients) if (client.active === 0 && Date.now() - client.touched > 60_000) {
        this.clients.delete(root); void this.retire(client);
      }
    }, 30_000);
    this.idle.unref();
  }

  private retire(client: TypeScriptClient): Promise<void> {
    const operation = client.dispose();
    this.closing.add(operation);
    void operation.finally(() => this.closing.delete(operation)).catch(() => undefined);
    return operation;
  }

  /** `background`: asked by the mouse; another query drops it while it waits (see TypeScriptClient.run). */
  async query(root: string, input: SemanticQuery, signal: AbortSignal, buffer?: string, background = false): Promise<SemanticResult> {
    signal.throwIfAborted();
    if (buffer !== undefined && Buffer.byteLength(buffer) > 2 * 1024 * 1024) throw new GraftError('language_file_limit', 'Semantic buffers must be no larger than 2 MiB.');
    if (this.disposed) throw new GraftError('language_server_closed', 'The language-server manager is closed.');
    const canonical = fs.realpathSync(root);
    // Validate before starting any executable; the tool additionally requires project trust.
    validatedFile(canonical, input.file);
    const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    let client = this.clients.get(key);
    if (client && !client.alive) { this.clients.delete(key); void this.retire(client); client = undefined; }
    if (!client) {
      if (this.clients.size >= 2) {
        const idle = [...this.clients].filter(([, c]) => c.active === 0).sort((a, b) => a[1].touched - b[1].touched)[0];
        if (!idle) throw new GraftError('language_server_busy', 'Two projects are using semantic servers. Retry after those queries finish.');
        this.clients.delete(idle[0]); void this.retire(idle[1]);
      }
      client = new TypeScriptClient(canonical); this.clients.set(key, client);
    }
    try { return await client.run(input, signal, buffer, background); }
    catch (error) {
      if (!client.alive || error instanceof GraftError && ['language_server_timeout', 'language_server_closed', 'language_diagnostics'].includes(error.code)) {
        if (this.clients.get(key) === client) this.clients.delete(key);
        await this.retire(client);
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.idle);
    const clients = [...this.clients.values()]; this.clients.clear();
    for (const client of clients) void this.retire(client);
    // Evicted, failed and idle clients are still ours until their shutdown ends.
    while (this.closing.size > 0) await Promise.allSettled([...this.closing]);
  }
}
