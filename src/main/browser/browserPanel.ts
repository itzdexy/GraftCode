import { session, WebContentsView, type BrowserWindow } from 'electron';
import { log } from '../app/log';
import { openExternalSafely } from '../app/security';
import { registerBrowserPanel } from './registry';

/**
 * The Browser panel: one isolated WebContentsView laid over the panel area.
 * No preload, sandboxed, its own in-memory partition, http(s) only, every
 * permission denied, downloads refused, new windows opened externally.
 */

export const BROWSER_PARTITION = 'graft-browser';

export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function isAllowedUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Accepts "localhost:3000" or "example.com" and adds a scheme; returns null for anything not http(s). */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return isAllowedUrl(trimmed) ? trimmed : null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^(localhost|[\w.-]+):\d+/i.test(trimmed)) return null;
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(trimmed);
  const candidate = `${local ? 'http' : 'https'}://${trimmed}`;
  return isAllowedUrl(candidate) ? candidate : null;
}

let partitionReady = false;

function preparePartition(): Electron.Session {
  const s = session.fromPartition(BROWSER_PARTITION);
  if (partitionReady) return s;
  partitionReady = true;
  s.setPermissionRequestHandler((_contents, permission, callback) => {
    log.info('browser', 'Denied a permission request', { permission });
    callback(false);
  });
  s.setPermissionCheckHandler(() => false);
  s.on('will-download', (event, item) => {
    event.preventDefault();
    log.info('browser', 'Blocked a download', { file: item.getFilename() });
  });
  return s;
}

export class BrowserPanel {
  private view: WebContentsView | null = null;
  private visible = false;
  private lastError: string | null = null;

  constructor(
    private readonly window: BrowserWindow,
    private readonly onState: (state: BrowserState) => void
  ) {}

  private ensure(): WebContentsView {
    if (this.view) return this.view;
    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false
      }
    });
    preparePartition();
    const contents = view.webContents;
    registerBrowserPanel(contents);
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedUrl(url)) void openExternalSafely(url);
      return { action: 'deny' };
    });
    const guard = (event: Electron.Event, url: string): void => {
      if (!isAllowedUrl(url)) {
        event.preventDefault();
        log.warn('browser', 'Blocked navigation to a non-web URL', { scheme: url.split(':')[0] ?? '' });
      }
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.on('will-attach-webview', (event) => event.preventDefault());
    const publish = (): void => this.publish();
    contents.on('did-start-loading', () => {
      this.lastError = null;
      publish();
    });
    contents.on('did-stop-loading', publish);
    contents.on('did-navigate', publish);
    contents.on('did-navigate-in-page', publish);
    contents.on('page-title-updated', publish);
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3 is an aborted load (e.g. a new navigation started); not an error to show.
      if (!isMainFrame || code === -3) return;
      this.lastError = `${description} (${url})`;
      publish();
    });
    contents.on('render-process-gone', (_event, details) => {
      this.lastError = `The page stopped (${details.reason}). Reload to try again.`;
      publish();
    });
    this.view = view;
    return view;
  }

  private publish(): void {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    this.onState({
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      error: this.lastError
    });
  }

  async navigate(input: string): Promise<string> {
    const url = normalizeUrl(input);
    if (!url) throw new Error('Only http and https addresses can be opened in the browser panel.');
    const view = this.ensure();
    this.lastError = null;
    try {
      await view.webContents.loadURL(url);
    } catch (error) {
      // loadURL rejects on failed loads; did-fail-load already recorded a readable message.
      log.info('browser', 'Page failed to load', { message: (error as Error).message });
    }
    this.publish();
    return url;
  }

  setBounds(bounds: Bounds | null): void {
    const view = this.view;
    if (!view) return;
    if (!bounds || bounds.width < 1 || bounds.height < 1) {
      if (this.visible) {
        this.window.contentView.removeChildView(view);
        this.visible = false;
      }
      return;
    }
    if (!this.visible) {
      this.window.contentView.addChildView(view);
      this.visible = true;
    }
    view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) });
  }

  back(): void {
    this.view?.webContents.navigationHistory.goBack();
  }

  forward(): void {
    this.view?.webContents.navigationHistory.goForward();
  }

  reload(): void {
    this.view?.webContents.reload();
  }

  stop(): void {
    this.view?.webContents.stop();
  }

  currentUrl(): string | null {
    const url = this.view?.webContents.getURL();
    return url && url.length > 0 ? url : null;
  }

  close(): void {
    const view = this.view;
    if (!view) return;
    if (this.visible) this.window.contentView.removeChildView(view);
    this.visible = false;
    this.view = null;
    view.webContents.close();
  }
}
