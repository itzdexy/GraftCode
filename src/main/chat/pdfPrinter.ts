import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, session, type Session } from 'electron';
import { pageSizeFor, type PrintPage } from './documents';

/**
 * Prints a page Graft built from a model's Markdown to a PDF. The page loads
 * in a hidden window with scripts switched off and Chromium's renderer
 * sandbox on. Its private in-memory session serves only the page being
 * printed, cancels every other request and refuses every permission, so
 * nothing a model wrote can run, reach the network or read the computer.
 * Prints go one at a time; each gets a fresh window that is destroyed when
 * the print ends or is given up on, so it never keeps the app open.
 */

const SCHEME = 'graft-doc';
const FOOTER = '<div style="width:100%;font-size:8px;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>';

/** The pages waiting to be printed, by the random id in their address. */
const pages = new Map<string, PrintPage>();
let isolated: Session | null = null;
let queue: Promise<unknown> = Promise.resolve();
/** Gives up on the print in flight. */
let stopCurrent: (() => void) | null = null;

function isolatedSession(): Session {
  if (isolated) return isolated;
  const ses = session.fromPartition('graft-documents', { cache: false });
  ses.protocol.handle(SCHEME, (request) => {
    const page = pages.get(request.url.slice(request.url.lastIndexOf('/') + 1));
    if (!page) return new Response(null, { status: 404 });
    return new Response(page.html, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': page.policy, 'cache-control': 'no-store' } });
  });
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${SCHEME}:`) && !details.url.startsWith('data:') }));
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  isolated = ses;
  return ses;
}

async function printOnce(page: PrintPage, signal: AbortSignal): Promise<Buffer> {
  if (signal.aborted) throw new Error('Stopped.');
  const id = randomUUID();
  pages.set(id, page);
  const win = new BrowserWindow({
    show: false,
    width: 816,
    height: 1056,
    webPreferences: {
      session: isolatedSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      webSecurity: true,
      spellcheck: false,
      devTools: false,
      disableDialogs: true
    }
  });
  const contents = win.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  let giveUp = (_error: Error): void => undefined;
  const gaveUp = new Promise<never>((_resolve, reject) => (giveUp = reject));
  const onAbort = (): void => giveUp(new Error('Stopped.'));
  signal.addEventListener('abort', onAbort, { once: true });
  stopCurrent = onAbort;
  contents.once('render-process-gone', () => giveUp(new Error('The page could not be printed.')));
  const printing = contents.loadURL(`${SCHEME}://print/${id}`).then(() =>
    contents.printToPDF({
      pageSize: pageSizeFor(app.getLocaleCountryCode()),
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: FOOTER,
      generateDocumentOutline: true,
      generateTaggedPDF: true
    })
  );
  // Once the print is given up on, the window is destroyed and this fails with nobody waiting for it.
  printing.catch(() => undefined);
  try {
    return await Promise.race([printing, gaveUp]);
  } finally {
    signal.removeEventListener('abort', onAbort);
    stopCurrent = null;
    pages.delete(id);
    if (!win.isDestroyed()) win.destroy();
  }
}

/** Gives up on the print in flight (when the app's window closes): its hidden window must not keep the app open. */
export function disposePrinter(): void {
  stopCurrent?.();
}

/** Prints a page to PDF; prints from all chats take turns. */
export function printHtmlToPdf(page: PrintPage, signal: AbortSignal): Promise<Buffer> {
  const print = queue.then(
    () => printOnce(page, signal),
    () => printOnce(page, signal)
  );
  queue = print.catch(() => undefined);
  return print;
}
