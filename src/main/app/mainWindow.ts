import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, screen, type TitleBarOverlayOptions } from 'electron';
import type { ResolvedTheme } from '@shared/ipc/contracts';
import { fitToDisplays, loadWindowState, MIN_WINDOW, saveWindowState } from './windowState';
import { log } from './log';

/** Titlebar overlay colors mirror --g-bg and --g-icon in tokens.css. */
const OVERLAY: Record<ResolvedTheme, TitleBarOverlayOptions> = {
  dark: { color: '#151515', symbolColor: '#c2c0b6', height: 32 },
  light: { color: '#fbfaf7', symbolColor: '#45443f', height: 32 }
};
const BACKGROUND: Record<ResolvedTheme, string> = { dark: '#151515', light: '#fbfaf7' };

export interface MainWindowOptions {
  stateFile: string;
  theme: ResolvedTheme;
  preloadPath: string;
  rendererDir: string;
  devServerUrl: string | undefined;
}

export interface MainWindowHandle {
  window: BrowserWindow;
  /** True when a frame URL belongs to this app's renderer. */
  isAppUrl(url: string): boolean;
  setTheme(theme: ResolvedTheme): void;
}

export function createMainWindow(options: MainWindowOptions): MainWindowHandle {
  const restored = fitToDisplays(
    loadWindowState(options.stateFile),
    screen.getAllDisplays().map((d) => d.workArea)
  );
  const isMac = process.platform === 'darwin';

  const window = new BrowserWindow({
    ...(restored.x !== undefined && restored.y !== undefined ? { x: restored.x, y: restored.y } : {}),
    width: restored.width,
    height: restored.height,
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    show: false,
    title: 'Graft',
    backgroundColor: BACKGROUND[options.theme],
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 12, y: 10 } } : { titleBarOverlay: OVERLAY[options.theme] }),
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
      devTools: !process.env.GRAFT_DISABLE_DEVTOOLS
    }
  });

  if (restored.maximized) window.maximize();
  window.once('ready-to-show', () => window.show());

  const persist = (): void => {
    if (window.isDestroyed() || window.isMinimized()) return;
    const maximized = window.isMaximized();
    const bounds = maximized ? window.getNormalBounds() : window.getBounds();
    try {
      saveWindowState(options.stateFile, { ...bounds, maximized });
    } catch (error) {
      log.warn('window', 'Could not persist window state', { message: (error as Error).message });
    }
  };
  let persistTimer: NodeJS.Timeout | undefined;
  const schedulePersist = (): void => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persist, 400);
  };
  window.on('resize', schedulePersist);
  window.on('move', schedulePersist);
  window.on('close', () => {
    clearTimeout(persistTimer);
    persist();
  });

  const indexFile = path.join(options.rendererDir, 'index.html');
  const indexUrl = pathToFileURL(indexFile).href;
  if (options.devServerUrl) {
    void window.loadURL(options.devServerUrl);
  } else {
    void window.loadFile(indexFile);
  }

  return {
    window,
    isAppUrl(url: string): boolean {
      if (options.devServerUrl) {
        try {
          return new URL(url).origin === new URL(options.devServerUrl).origin;
        } catch {
          return false;
        }
      }
      return url.split('#')[0]?.split('?')[0] === indexUrl;
    },
    setTheme(theme: ResolvedTheme): void {
      if (window.isDestroyed()) return;
      window.setBackgroundColor(BACKGROUND[theme]);
      if (!isMac) window.setTitleBarOverlay(OVERLAY[theme]);
    }
  };
}
