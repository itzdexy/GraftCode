import { nativeImage, session, WebContentsView, type BrowserWindow, type WebContents } from 'electron';
import { PAGE_SIZES, type PageSize } from '@shared/schemas/panels';
import { log } from '../app/log';
import { openExternalSafely } from '../app/security';
import { checkPage, type PageCheck, type PageFacts } from './pageCheck';
import { CANCEL_PICK, fill, GRAFT_WORLD, hasText, highlight, locate, PAGE_FACTS, PICK_ELEMENT, scrollBy, SNAPSHOT } from './pageScripts';
import { registerBrowserPanel } from './registry';

/**
 * The Browser panel: one isolated WebContentsView laid over the panel area.
 * No preload, sandboxed, its own in-memory partition, http(s) only, every
 * permission denied, downloads refused, new windows opened externally. Graft's
 * own page scripts (element picker, agent snapshots, the page check) run in an
 * isolated world.
 */

export const BROWSER_PARTITION = 'graft-browser';

export interface ConsoleEntry {
  level: 'debug' | 'info' | 'warning' | 'error';
  message: string;
  source: string;
  line: number;
  at: number;
}

export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
  /** Page zoom; 1 is 100%. */
  zoom: number;
  /** Errors and warnings the page logged since it loaded. */
  problems: number;
  find: { active: number; matches: number } | null;
  devtools: boolean;
  /** The element picker is waiting for a click. */
  picking: boolean;
}

export type BrowserShortcut = 'find' | 'address';

export interface PickedElement {
  url: string;
  selector: string;
  html: string;
  text: string;
  size: { width: number; height: number };
  styles: Record<string, string>;
}

export interface PageSnapshot {
  title: string;
  url: string;
  text: string;
  truncated: boolean;
  items: Array<{ ref: number; role: string; label: string; selector: string; value?: string; checked?: boolean; disabled?: boolean }>;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageShot {
  mediaType: 'image/png' | 'image/jpeg';
  data: string;
  width: number;
  height: number;
}

/** A page that is not on screen is drawn at this size. */
const HIDDEN_SIZE: PageSize = { width: 1280, height: 800 };
/** A picture that has not come after this long is not coming (the page stopped drawing). */
const DRAW_TIMEOUT_MS = 8000;

function within<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const MAX_CONSOLE = 500;
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const LOAD_TIMEOUT_MS = 20_000;

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
  // Local addresses, sites included (peach-palace.localhost:4870), are plain http.
  const local = /^([a-z0-9-]+\.)*(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(trimmed);
  const candidate = `${local ? 'http' : 'https'}://${trimmed}`;
  return isAllowedUrl(candidate) ? candidate : null;
}

/** The next zoom step in a direction ("reset" is 100%). */
export function nextZoom(current: number, direction: 'in' | 'out' | 'reset'): number {
  if (direction === 'reset') return 1;
  if (direction === 'in') return ZOOM_STEPS.find((z) => z > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
  return [...ZOOM_STEPS].reverse().find((z) => z < current - 0.001) ?? ZOOM_STEPS[0]!;
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
  private consoleEntries: ConsoleEntry[] = [];
  private problems = 0;
  private find: BrowserState['find'] = null;
  private picking = false;
  /** The page is laid out at a size of its own for a picture or a check; the panel's bounds wait until it is back. */
  private measuring = false;
  /** The bounds asked for while measuring: undefined when none were. */
  private wanted: Bounds | null | undefined;

  constructor(
    private readonly window: BrowserWindow,
    private readonly onState: (state: BrowserState) => void,
    private readonly onShortcut: (shortcut: BrowserShortcut) => void = () => undefined
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
        spellcheck: false,
        // The agent reads and screenshots the page while the panel may be hidden.
        backgroundThrottling: false
      }
    });
    preparePartition();
    // A real viewport before the panel lays it out: a page the agent opens while the
    // panel is still hidden would otherwise render at 0×0 and show no elements.
    view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
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
    contents.on('did-start-navigation', (details) => {
      // A new page starts with an empty console, like the DevTools default.
      if (details.isMainFrame && !details.isSameDocument) {
        this.consoleEntries = [];
        this.problems = 0;
        this.find = null;
        this.picking = false;
      }
    });
    contents.on('did-stop-loading', publish);
    contents.on('did-navigate', publish);
    contents.on('did-navigate-in-page', publish);
    contents.on('page-title-updated', publish);
    contents.on('devtools-opened', publish);
    contents.on('devtools-closed', publish);
    contents.on('zoom-changed', publish);
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3 is an aborted load (e.g. a new navigation started); not an error to show.
      if (!isMainFrame || code === -3) return;
      this.lastError = `${description} (${url})`;
      publish();
    });
    contents.on('render-process-gone', (_event, details) => {
      this.lastError = `The page stopped (${details.reason}). Reload to try again.`;
      this.picking = false;
      publish();
    });
    contents.on('console-message', (details) => {
      // Electron's own advice to app developers (development builds only); not the page's.
      if (details.message.includes('Electron Security Warning')) return;
      const entry: ConsoleEntry = { level: details.level, message: details.message.slice(0, 4000), source: details.sourceId, line: details.lineNumber, at: Date.now() };
      this.consoleEntries.push(entry);
      if (this.consoleEntries.length > MAX_CONSOLE) this.consoleEntries.splice(0, this.consoleEntries.length - MAX_CONSOLE);
      if (entry.level === 'error' || entry.level === 'warning') {
        this.problems++;
        publish();
      }
    });
    contents.on('found-in-page', (_event, result) => {
      this.find = { active: result.activeMatchOrdinal, matches: result.matches };
      publish();
    });
    contents.on('before-input-event', (event, input) => this.onKey(event, input));
    this.view = view;
    return view;
  }

  /** Browser shortcuts while the page has focus; the app's own shortcuts can't see these keys. */
  private onKey(event: Electron.Event, input: Electron.Input): void {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const key = input.key.toLowerCase();
    const handled = (): void => event.preventDefault();
    if (mod && key === 'f') {
      handled();
      this.onShortcut('find');
    } else if (mod && key === 'l') {
      handled();
      this.onShortcut('address');
    } else if (key === 'f5' || (mod && key === 'r')) {
      handled();
      if (input.shift) this.hardReload();
      else this.reload();
    } else if (key === 'f12' || (mod && input.shift && key === 'i')) {
      handled();
      this.toggleDevTools();
    } else if (mod && (key === '=' || key === '+')) {
      handled();
      this.zoom('in');
    } else if (mod && key === '-') {
      handled();
      this.zoom('out');
    } else if (mod && key === '0') {
      handled();
      this.zoom('reset');
    } else if (input.alt && key === 'arrowleft') {
      handled();
      this.back();
    } else if (input.alt && key === 'arrowright') {
      handled();
      this.forward();
    }
  }

  private contents(): WebContents | null {
    const contents = this.view?.webContents;
    return contents && !contents.isDestroyed() ? contents : null;
  }

  private publish(): void {
    const contents = this.contents();
    if (!contents) return;
    this.onState({
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      error: this.lastError,
      zoom: contents.getZoomFactor(),
      problems: this.problems,
      find: this.find,
      devtools: contents.isDevToolsOpened(),
      picking: this.picking
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
    if (this.measuring) {
      this.wanted = bounds;
      return;
    }
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
    this.contents()?.navigationHistory.goBack();
  }

  forward(): void {
    this.contents()?.navigationHistory.goForward();
  }

  reload(): void {
    this.contents()?.reload();
  }

  /** Reloads without the cache, for when a dev server's assets look stale. */
  hardReload(): void {
    this.contents()?.reloadIgnoringCache();
  }

  stop(): void {
    this.contents()?.stop();
  }

  zoom(direction: 'in' | 'out' | 'reset'): void {
    const contents = this.contents();
    if (!contents) return;
    contents.setZoomFactor(nextZoom(contents.getZoomFactor(), direction));
    this.publish();
  }

  toggleDevTools(): void {
    const contents = this.contents();
    if (!contents) return;
    if (contents.isDevToolsOpened()) contents.closeDevTools();
    else contents.openDevTools({ mode: 'detach' });
  }

  findInPage(text: string, forward: boolean, next: boolean): void {
    const contents = this.contents();
    if (!contents) return;
    if (text.length === 0) {
      this.stopFind();
      return;
    }
    contents.findInPage(text, { forward, findNext: next });
  }

  stopFind(): void {
    this.contents()?.stopFindInPage('clearSelection');
    this.find = null;
    this.publish();
  }

  consoleLog(): ConsoleEntry[] {
    return [...this.consoleEntries];
  }

  clearConsole(): void {
    this.consoleEntries = [];
    this.problems = 0;
    this.publish();
  }

  /** Clears the panel's cookies, storage and cache (its partition only; nothing else in Graft). */
  async clearSiteData(): Promise<void> {
    const s = preparePartition();
    await s.clearStorageData();
    await s.clearCache();
    this.contents()?.reload();
  }

  /**
   * Runs `look` while the page is laid out at `size`, whatever size the panel is, and puts everything back.
   * A page is only drawn while it is in the window, so one that is hidden is put there as a single pixel in
   * a corner for the moment (measured: a view outside the window, or beside it, is never drawn). The layout
   * is set through the DevTools protocol, as a browser's device toolbar does.
   */
  private async atSize<T>(size: PageSize, look: (contents: WebContents) => Promise<T>): Promise<T> {
    const view = this.view;
    const contents = this.contents();
    if (!view || !contents || contents.getURL() === '') throw new Error('No page is open in the browser.');
    if (this.measuring) throw new Error('The page is being looked at already. Try again in a moment.');
    this.measuring = true;
    this.wanted = undefined;
    const hidden = !this.visible;
    const zoom = contents.getZoomFactor();
    const protocol = contents.debugger;
    try {
      if (hidden) {
        const area = this.window.getContentBounds();
        view.setBounds({ x: Math.max(0, area.width - 1), y: Math.max(0, area.height - 1), width: 1, height: 1 });
        this.window.contentView.addChildView(view);
      }
      // A zoomed page counts its width in larger pixels: at 100% the width asked for is the width it gets.
      if (zoom !== 1) contents.setZoomFactor(1);
      try {
        protocol.attach('1.3');
      } catch (error) {
        throw new Error(`The page can't be laid out at another size right now (${(error as Error).message}). If its developer tools are open, close them and try again.`, { cause: error });
      }
      await protocol.sendCommand('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
      // Two frames for the new layout, and a moment for what follows it (a font, a query that swaps a picture).
      await contents.executeJavaScriptInIsolatedWorld(GRAFT_WORLD, [{ code: 'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done(true), 120))))' }], true);
      return await look(contents);
    } finally {
      try {
        if (protocol.isAttached()) {
          await protocol.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
          protocol.detach();
        }
        if (!contents.isDestroyed() && zoom !== 1) contents.setZoomFactor(zoom);
        if (hidden && this.view === view) {
          this.window.contentView.removeChildView(view);
          view.setBounds({ x: 0, y: 0, ...HIDDEN_SIZE });
        }
      } catch (error) {
        // The page was closed while it was looked at: there is nothing left to put back.
        log.info('browser', 'Could not restore the page after looking at it', { message: (error as Error).message });
      }
      this.measuring = false;
      const wanted = this.wanted;
      this.wanted = undefined;
      if (wanted !== undefined) this.setBounds(wanted);
    }
  }

  /**
   * The page as an image for a chat: as the panel shows it, or laid out at `size`. A page that is not on
   * screen is drawn at the size of a desktop. Wider than 1600 px it is scaled down; JPEG when PNG would be heavy.
   */
  async capture(size?: PageSize): Promise<PageShot> {
    const contents = this.contents();
    if (!contents || contents.getURL() === '') throw new Error('No page is open in the browser.');
    const late = 'The page did not draw in time. Reload it and try again.';
    let image =
      size || !this.visible
        ? await this.atSize(size ?? HIDDEN_SIZE, async (page) => {
            const shot = (await within(page.debugger.sendCommand('Page.captureScreenshot', { format: 'png' }), DRAW_TIMEOUT_MS, late)) as { data: string };
            return nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
          })
        : await within(contents.capturePage(), DRAW_TIMEOUT_MS, late);
    if (image.isEmpty()) throw new Error('The page has nothing to show yet (it may still be loading).');
    if (image.getSize().width > 1600) image = image.resize({ width: 1600, quality: 'good' });
    const png = image.toPNG();
    const { width, height } = image.getSize();
    if (png.length <= 1_500_000) return { mediaType: 'image/png', data: png.toString('base64'), width, height };
    return { mediaType: 'image/jpeg', data: image.toJPEG(85).toString('base64'), width, height };
  }

  /** The page as a phone, a tablet and a desktop lay it out, one after the other. */
  async captureSizes(): Promise<Array<{ id: (typeof PAGE_SIZES)[number]['id']; label: string; shot: PageShot }>> {
    const shots: Array<{ id: (typeof PAGE_SIZES)[number]['id']; label: string; shot: PageShot }> = [];
    for (const size of PAGE_SIZES) shots.push({ id: size.id, label: `${size.label} (${String(size.width)} px)`, shot: await this.capture({ width: size.width, height: size.height }) });
    return shots;
  }

  /**
   * What is wrong with the page as it is laid out now, or at `size`: contrast, names, headings, a layout wider
   * than its window. It reads the page and changes nothing in it.
   */
  async check(size?: PageSize): Promise<PageCheck> {
    const contents = this.contents();
    if (!contents || contents.getURL() === '') throw new Error('No page is open in the browser.');
    const gather = async (page: WebContents): Promise<PageCheck> => checkPage((await page.executeJavaScriptInIsolatedWorld(GRAFT_WORLD, [{ code: PAGE_FACTS }], true)) as PageFacts);
    return size ? this.atSize(size, gather) : gather(contents);
  }

  /** Brings what a selector finds into view and marks it for a moment; false when it finds nothing. */
  async highlight(selector: string): Promise<boolean> {
    const contents = this.contents();
    if (!contents) return false;
    return (await contents.executeJavaScriptInIsolatedWorld(GRAFT_WORLD, [{ code: highlight(selector) }], true).catch(() => false)) === true;
  }

  /** Lets the user click an element in the page; null when they press Escape or leave the page. */
  async pickElement(): Promise<PickedElement | null> {
    const contents = this.contents();
    if (!contents || contents.getURL() === '') throw new Error('Open a page first.');
    this.picking = true;
    this.publish();
    try {
      const picked = (await contents.executeJavaScriptInIsolatedWorld(GRAFT_WORLD, [{ code: PICK_ELEMENT }], true)) as Omit<PickedElement, 'url'> | null;
      return picked ? { ...picked, url: contents.getURL() } : null;
    } catch (error) {
      // The page navigated away or crashed mid-pick.
      log.info('browser', 'Element picking ended', { message: (error as Error).message });
      return null;
    } finally {
      this.picking = false;
      this.publish();
    }
  }

  cancelPick(): void {
    void this.contents()
      ?.executeJavaScriptInIsolatedWorld(GRAFT_WORLD, [{ code: CANCEL_PICK }], true)
      .catch(() => undefined);
  }

  currentUrl(): string | null {
    const url = this.contents()?.getURL();
    return url && url.length > 0 ? url : null;
  }

  isVisible(): boolean {
    return this.visible;
  }

  // ---- What the agent's Browser tool uses ----

  /** Waits for the page to finish loading (or gives up after a while; slow pages still get read). */
  async settle(timeoutMs = LOAD_TIMEOUT_MS): Promise<void> {
    const contents = this.contents();
    if (!contents) return;
    // Give a click or submit a moment to start a navigation before checking.
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!contents.isLoading()) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      function done(): void {
        clearTimeout(timer);
        contents?.off('did-stop-loading', done);
        resolve();
      }
      contents.on('did-stop-loading', done);
    });
  }

  async snapshot(): Promise<PageSnapshot> {
    const contents = this.contents();
    if (!contents || contents.getURL() === '') throw new Error('No page is open. Use action "open" first.');
    return (await contents.executeJavaScriptInIsolatedWorld(GRAFT_WORLD, [{ code: SNAPSHOT }], true)) as PageSnapshot;
  }

  /** Clicks an element with real mouse events, which frameworks handle like a person's click. */
  async click(target: { ref?: number; selector?: string; text?: string }): Promise<string> {
    const contents = this.contents();
    if (!contents) throw new Error('No page is open. Use action "open" first.');
    const found = (await contents.executeJavaScriptInIsolatedWorld(GRAFT_WORLD, [{ code: locate(target) }], true)) as
      | { ok: true; x: number; y: number; label: string; selector: string; disabled: boolean }
      | { ok: false; reason: string };
    if (!found.ok) throw new Error(found.reason);
    if (found.disabled) throw new Error(`"${found.label || found.selector}" is disabled.`);
    // Page coordinates are CSS pixels; input events want the view's pixels.
    const zoom = contents.getZoomFactor();
    const x = Math.round(found.x * zoom);
    const y = Math.round(found.y * zoom);
    contents.sendInputEvent({ type: 'mouseMove', x, y });
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await this.settle();
    return found.label || found.selector;
  }

  async type(target: { ref?: number; selector?: string; text?: string }, value: string, submit: boolean): Promise<string> {
    const contents = this.contents();
    if (!contents) throw new Error('No page is open. Use action "open" first.');
    const found = (await contents.executeJavaScriptInIsolatedWorld(GRAFT_WORLD, [{ code: locate(target) }], true)) as
      | { ok: true; label: string; selector: string; disabled: boolean; editable: boolean }
      | { ok: false; reason: string };
    if (!found.ok) throw new Error(found.reason);
    if (!found.editable) throw new Error(`"${found.label || found.selector}" isn't a field you can type into.`);
    const result = (await contents.executeJavaScriptInIsolatedWorld(GRAFT_WORLD, [{ code: fill(value, submit) }], true)) as { ok: boolean; reason?: string };
    if (!result.ok) throw new Error(result.reason ?? 'Typing failed.');
    if (submit) await this.settle();
    return found.label || found.selector;
  }

  /** Presses a key (Enter, Escape, Tab, arrows…) as real keyboard input. */
  async press(key: string): Promise<void> {
    const contents = this.contents();
    if (!contents) throw new Error('No page is open. Use action "open" first.');
    contents.sendInputEvent({ type: 'keyDown', keyCode: key });
    if (key.length === 1) contents.sendInputEvent({ type: 'char', keyCode: key });
    contents.sendInputEvent({ type: 'keyUp', keyCode: key });
    await this.settle();
  }

  async scroll(direction: 'up' | 'down'): Promise<void> {
    const contents = this.contents();
    if (!contents) throw new Error('No page is open. Use action "open" first.');
    await contents.executeJavaScriptInIsolatedWorld(GRAFT_WORLD, [{ code: scrollBy(direction) }], true);
  }

  /** Waits until the page shows some text; true when it did before the time ran out. */
  async waitForText(text: string, timeoutMs: number): Promise<boolean> {
    const contents = this.contents();
    if (!contents) throw new Error('No page is open. Use action "open" first.');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = (await contents.executeJavaScriptInIsolatedWorld(GRAFT_WORLD, [{ code: hasText(text) }], true).catch(() => false)) as boolean;
      if (found) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  close(): void {
    const view = this.view;
    if (!view) return;
    if (this.visible) this.window.contentView.removeChildView(view);
    this.visible = false;
    this.view = null;
    this.consoleEntries = [];
    this.problems = 0;
    this.find = null;
    this.picking = false;
    this.wanted = undefined;
    view.webContents.close();
  }
}
