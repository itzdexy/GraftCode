import { BrowserWindow, session, type Session } from 'electron';

/**
 * RunCode's sandbox: JavaScript runs in a hidden page with Chromium's
 * renderer sandbox on and no Node. Its private in-memory session cancels
 * every request and refuses every permission, so the code can't reach the
 * network, the computer's files or devices. Every run starts on a fresh
 * blank document, so nothing from an earlier run survives; a run that times
 * out or crashes takes the page down with it (that also stops endless
 * loops). Runs go one at a time, output and files are capped, and the page
 * closes when idle so it never keeps the app open.
 */
export interface CodeRun {
  /** What the code printed, then its return value. */
  output: string;
  error: string | null;
  timedOut: boolean;
  durationMs: number;
  files: Array<{ name: string; data: Buffer }>;
}

const MAX_OUTPUT_CHARS = 20_000;
const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const IDLE_CLOSE_MS = 15_000;

let isolated: Session | null = null;
let page: BrowserWindow | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let queue: Promise<unknown> = Promise.resolve();

function isolatedSession(): Session {
  if (isolated) return isolated;
  const ses = session.fromPartition('graft-code-sandbox', { cache: false });
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== 'about:blank' }));
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  isolated = ses;
  return ses;
}

function sandboxPage(): BrowserWindow {
  if (page && !page.isDestroyed()) return page;
  const win = new BrowserWindow({
    show: false,
    width: 480,
    height: 320,
    webPreferences: {
      session: isolatedSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: false,
      disableDialogs: true,
      backgroundThrottling: false
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  page = win;
  return win;
}

/**
 * Closes the sandbox page (when idle and when the app's window closes).
 * `kill` first ends its renderer process: code stuck in a loop keeps a
 * process busy even after its page is gone, and the next page could land
 * in that same process.
 */
export function disposeSandbox(kill = false): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (page && !page.isDestroyed()) {
    if (kill && !page.webContents.isDestroyed()) page.webContents.forcefullyCrashRenderer();
    page.destroy();
  }
  page = null;
}

/** A blank document in the sandbox page; retried on a fresh page while a previous one is still going away. */
async function freshDocument(): Promise<BrowserWindow> {
  for (let attempt = 1; ; attempt++) {
    const win = sandboxPage();
    try {
      await Promise.race([
        win.loadURL('about:blank'),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('The sandbox page did not start.')), 10_000))
      ]);
      return win;
    } catch (error) {
      disposeSandbox(true);
      if (attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

/** The script the page runs: console capture, graft.writeFile, then the code as an async function body. */
export function runnerScript(code: string): string {
  return `(async () => {
  const code = ${JSON.stringify(code)};
  const lines = [];
  let size = 0;
  const show = (value) => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || String(value);
    try {
      const text = JSON.stringify(value, (_key, x) => (typeof x === 'bigint' ? x.toString() + 'n' : x), 2);
      return text === undefined ? String(value) : text;
    } catch {
      return String(value);
    }
  };
  const print = (prefix) => (...args) => {
    const line = prefix + args.map(show).join(' ');
    size += line.length + 1;
    if (size <= ${String(MAX_OUTPUT_CHARS)}) lines.push(line);
  };
  console.log = console.info = console.debug = console.table = print('');
  console.warn = print('Warning: ');
  console.error = print('Error: ');
  const files = [];
  const toBytes = (data) => {
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new TextEncoder().encode(show(data));
  };
  const graft = Object.freeze({
    writeFile(name, data) {
      if (files.length >= ${String(MAX_FILES)}) throw new Error('A run can create at most ${String(MAX_FILES)} files.');
      const bytes = toBytes(data);
      if (bytes.length > ${String(MAX_FILE_BYTES)}) throw new Error('Files can be up to 10 MB.');
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      files.push({ name: String(name), base64: btoa(binary) });
      return String(name);
    }
  });
  let error = null;
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const value = await new AsyncFunction('graft', code)(graft);
    if (value !== undefined) print('')(value);
  } catch (e) {
    error = e instanceof Error ? e.stack || String(e) : 'Uncaught ' + show(e);
  }
  return { lines, truncated: size > ${String(MAX_OUTPUT_CHARS)}, error, files };
})()`;
}

type PageResult = { lines: string[]; truncated: boolean; error: string | null; files: Array<{ name: string; base64: string }> };
type Outcome = { kind: 'done'; value: PageResult } | { kind: 'timeout' } | { kind: 'aborted' } | { kind: 'crashed'; reason: string };

async function runOnce(code: string, timeoutMs: number, signal: AbortSignal): Promise<CodeRun> {
  const started = Date.now();
  const finish = (partial: Omit<CodeRun, 'durationMs'>): CodeRun => ({ ...partial, durationMs: Date.now() - started });
  if (idleTimer) clearTimeout(idleTimer);
  if (signal.aborted) return finish({ output: '', error: 'Stopped.', timedOut: false, files: [] });
  const win = await freshDocument();
  const contents = win.webContents;
  const outcome = await new Promise<Outcome>((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    const onAbort = (): void => resolve({ kind: 'aborted' });
    const onGone = (_event: unknown, details: { reason: string }): void => resolve({ kind: 'crashed', reason: details.reason });
    signal.addEventListener('abort', onAbort, { once: true });
    contents.once('render-process-gone', onGone);
    contents
      .executeJavaScript(runnerScript(code), true)
      .then((value: unknown) => resolve({ kind: 'done', value: value as PageResult }))
      .catch((error: unknown) => resolve({ kind: 'done', value: { lines: [], truncated: false, error: error instanceof Error ? error.message : String(error), files: [] } }))
      .finally(() => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (!contents.isDestroyed()) contents.removeListener('render-process-gone', onGone);
      });
  });
  if (outcome.kind !== 'done') {
    // The page may still be busy (an endless loop): only ending its process stops the code.
    disposeSandbox(true);
    if (outcome.kind === 'timeout') {
      return finish({ output: '', error: `Stopped after ${String(Math.round(timeoutMs / 1000))} s: the code took too long (an endless loop?).`, timedOut: true, files: [] });
    }
    if (outcome.kind === 'aborted') return finish({ output: '', error: 'Stopped.', timedOut: false, files: [] });
    return finish({ output: '', error: outcome.reason === 'oom' ? 'The code used too much memory.' : `The sandbox stopped (${outcome.reason}).`, timedOut: false, files: [] });
  }
  idleTimer = setTimeout(disposeSandbox, IDLE_CLOSE_MS);
  const { lines, truncated, error, files } = outcome.value;
  const output = lines.join('\n') + (truncated ? '\n… (output shortened)' : '');
  return finish({ output, error, timedOut: false, files: files.map((f) => ({ name: f.name, data: Buffer.from(f.base64, 'base64') })) });
}

/** Runs code in the sandbox; runs from all chats take turns. */
export function runInSandbox(code: string, timeoutMs: number, signal: AbortSignal): Promise<CodeRun> {
  const run = queue.then(
    () => runOnce(code, timeoutMs, signal),
    () => runOnce(code, timeoutMs, signal)
  );
  queue = run.catch(() => undefined);
  return run;
}
