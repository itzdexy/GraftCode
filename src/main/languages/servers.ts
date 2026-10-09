import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CancellationTokenSource, createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/node';
import { z } from 'zod';
import { GraftError } from '@shared/errors';
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
  private readonly documents = new Map<string, number>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
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
      capabilities: { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
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

  run(input: SemanticQuery, signal: AbortSignal, buffer?: string): Promise<SemanticResult> {
    this.active++;
    const operation = this.tail.then(async () => {
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
    return abortable(operation.finally(() => { this.active--; this.touched = Date.now(); }), signal);
  }

  private location(uri: string, position: z.infer<typeof Position>): CodeLocation | null {
    try {
      const file = fs.realpathSync(fileURLToPath(uri));
      return within(this.root, file) ? { file: path.relative(this.root, file).replaceAll(path.sep, '/'), line: position.line + 1, column: position.character + 1 } : null;
    } catch { return null; }
  }

  private async query(input: SemanticQuery, signal: AbortSignal, buffer?: string): Promise<SemanticResult> {
    const file = validatedFile(this.root, input.file);
    const text = buffer ?? fs.readFileSync(file, 'utf8');
    const uri = pathToFileURL(file).href;
    if (!this.documents.has(uri) && this.documents.size >= 64) {
      const oldest = this.documents.keys().next().value;
      if (oldest) { await this.connection.sendNotification('textDocument/didClose', { textDocument: { uri: oldest } }); this.documents.delete(oldest); }
    }
    const version = (this.documents.get(uri) ?? 0) + 1;
    this.documents.set(uri, version);
    if (version === 1) await this.connection.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: /\.tsx$/i.test(file) ? 'typescriptreact' : /\.[cm]?ts$/i.test(file) ? 'typescript' : /\.jsx$/i.test(file) ? 'javascriptreact' : 'javascript', version, text } });
    else await this.connection.sendNotification('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
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
    if (!input.line || !input.column) throw new GraftError('language_position', 'Give a 1-based line and column for definition, references or hover.');
    const lines = text.split(/\r\n|\n|\r/);
    if (input.line > lines.length || input.column > (lines[input.line - 1]?.length ?? 0) + 1) throw new GraftError('language_position', 'The line or column is outside the current file. Read the current file and retry.');
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

  async dispose(): Promise<void> {
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
    if (!this.closed) {
      try { await Promise.race([this.connection.sendRequest('shutdown'), new Promise((resolve) => { shutdownTimer = setTimeout(resolve, 1000); })]); await this.connection.sendNotification('exit'); }
      catch { /* a dead server still needs local transport cleanup */ }
      finally { if (shutdownTimer) clearTimeout(shutdownTimer); }
    }
    this.closed = true;
    this.connection.dispose();
    // Wait for graceful exit (and tsserver cleanup) before force-killing the wrapper.
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.exited, new Promise<void>((resolve) => { exitTimer = setTimeout(() => { this.child.kill(); resolve(); }, 2000); })]); }
    finally { if (exitTimer) clearTimeout(exitTimer); }
  }
}

/** Bounded, on-demand local LSP processes; each project/private writer gets separate documents. */
export class LanguageServers {
  private readonly clients = new Map<string, TypeScriptClient>();
  private disposed = false;
  private readonly idle: ReturnType<typeof setInterval>;
  constructor() {
    this.idle = setInterval(() => {
      for (const [root, client] of this.clients) if (client.active === 0 && Date.now() - client.touched > 60_000) {
        this.clients.delete(root); void client.dispose();
      }
    }, 30_000);
    this.idle.unref();
  }

  async query(root: string, input: SemanticQuery, signal: AbortSignal, buffer?: string): Promise<SemanticResult> {
    signal.throwIfAborted();
    if (buffer !== undefined && Buffer.byteLength(buffer) > 2 * 1024 * 1024) throw new GraftError('language_file_limit', 'Semantic buffers must be no larger than 2 MiB.');
    if (this.disposed) throw new GraftError('language_server_closed', 'The language-server manager is closed.');
    const canonical = fs.realpathSync(root);
    // Validate before starting any executable; the tool additionally requires project trust.
    validatedFile(canonical, input.file);
    const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    let client = this.clients.get(key);
    if (client && !client.alive) { this.clients.delete(key); void client.dispose(); client = undefined; }
    if (!client) {
      if (this.clients.size >= 2) {
        const idle = [...this.clients].filter(([, c]) => c.active === 0).sort((a, b) => a[1].touched - b[1].touched)[0];
        if (!idle) throw new GraftError('language_server_busy', 'Two projects are using semantic servers. Retry after those queries finish.');
        this.clients.delete(idle[0]); void idle[1].dispose();
      }
      client = new TypeScriptClient(canonical); this.clients.set(key, client);
    }
    try { return await client.run(input, signal, buffer); }
    catch (error) {
      if (!client.alive || error instanceof GraftError && ['language_server_timeout', 'language_server_closed', 'language_diagnostics'].includes(error.code)) {
        if (this.clients.get(key) === client) this.clients.delete(key);
        await client.dispose();
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.idle);
    const clients = [...this.clients.values()]; this.clients.clear();
    await Promise.allSettled(clients.map((client) => client.dispose()));
  }
}
