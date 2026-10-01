import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, nativeTheme, safeStorage } from 'electron';
import type { AppInfo } from '@shared/ipc/contracts';
import { GraftEventSchema, type GraftEvent } from '@shared/ipc/events';
import { IPC_EVENT } from '@shared/ipc/result';
import { SessionManager } from './agent/sessionManager';
import { BrowserPanel } from './browser/browserPanel';
import { buildPaths } from './app/paths';
import { configureLogFile, log } from './app/log';
import { createMainWindow, type MainWindowHandle } from './app/mainWindow';
import { showSessionNotification } from './app/notifications';
import { installSecurityPolicy } from './app/security';
import { initServices, type Services } from './app/services';
import { buildHandlers } from './ipc/handlers';
import { installRouter, missingHandlers, registerHandlers } from './ipc/router';
import { PtyManager } from './pty/ptyManager';

// Test and E2E runs isolate all state before anything touches userData.
if (process.env.GRAFT_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.GRAFT_USER_DATA_DIR));
}

const paths = buildPaths(app.getPath('userData'));
configureLogFile(paths.logs);
const isFirstLaunch = !fs.existsSync(paths.database);

let mainWindow: MainWindowHandle | null = null;
let servicesPromise: Promise<Services> | null = null;
let sessionManager: SessionManager | null = null;
let ptyManager: PtyManager | null = null;
let browserPanel: BrowserPanel | null = null;
let quitting = false;

function platform(): AppInfo['platform'] {
  const p = process.platform;
  if (p === 'win32' || p === 'darwin' || p === 'linux') return p;
  throw new Error(`Unsupported platform: ${p}`);
}

function emit(event: GraftEvent): void {
  const win = mainWindow?.window;
  if (!win || win.isDestroyed()) return;
  if (!app.isPackaged) {
    const parsed = GraftEventSchema.safeParse(event);
    if (!parsed.success) {
      log.error('ipc', 'Dropped an invalid event', { type: event.type, issue: parsed.error.issues[0]?.message ?? '' });
      return;
    }
  }
  win.webContents.send(IPC_EVENT, event);
}

function focusSession(sessionId: string): void {
  const win = mainWindow?.window;
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  emit({ type: 'app:navigate', sessionId });
}

/** Starts initialization once; the boot screen shows its progress. */
function services(): Promise<Services> {
  servicesPromise ??= initServices({
    paths,
    encryptor: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (text) => safeStorage.encryptString(text),
      decryptString: (buffer) => safeStorage.decryptString(buffer)
    },
    onProgress: (step, label, done, total) => emit({ type: 'init:progress', step, label, done, total })
  })
    .then((s) => {
      s.shells.on('change', (sessionId: string) => emit({ type: 'shells:changed', sessionId }));
      s.shells.on('error-log', (message: string) => log.warn('shell', message));
      return s;
    })
    .catch((error: unknown) => {
      log.error('app', 'Initialization failed', { message: (error as Error).message });
      servicesPromise = null;
      throw error;
    });
  return servicesPromise;
}

async function ptys(): Promise<PtyManager> {
  if (ptyManager) return ptyManager;
  const s = await services();
  ptyManager ??= new PtyManager(s.shell, {
    data: (id, data, offset) => emit({ type: 'pty:data', id, data, offset }),
    exit: (id, exitCode) => emit({ type: 'pty:exit', id, exitCode }),
    log: (message) => log.warn('pty', message)
  });
  return ptyManager;
}

function browser(): BrowserPanel {
  const win = mainWindow?.window;
  if (!win) throw new Error('The window is closed.');
  browserPanel ??= new BrowserPanel(win, (state) => emit({ type: 'browser:state', state }));
  return browserPanel;
}

async function sessions(): Promise<SessionManager> {
  if (sessionManager) return sessionManager;
  const s = await services();
  sessionManager ??= new SessionManager({
    repo: s.sessionsRepo,
    projects: s.projects,
    registry: s.registry,
    settings: s.settings,
    settingsFiles: s.settingsFiles,
    tools: s.tools,
    shells: s.shells,
    shell: s.shell,
    checkpoints: s.checkpoints,
    paths: s.paths,
    rgPath: s.rgPath,
    mcp: null,
    emitEvent: (sessionId, event) => emit({ type: 'session:event', sessionId, event }),
    emitSummary: (summary) => emit({ type: 'session:summary', summary }),
    emitRemoved: (sessionId) => emit({ type: 'session:removed', sessionId }),
    filesChanged: (dir) => s.diffStats.invalidate(dir),
    notify: (summary, kind, text, visible) =>
      showSessionNotification({ settings: s.settings.get(), summary, kind, text, visible, onClick: focusSession }),
    log: (level, message, fields) => log[level]('session', message, fields)
  });
  sessionManager.recoverStaleStatuses();
  sessionManager.setWindowFocused(mainWindow?.window.isFocused() ?? true);
  return sessionManager;
}

function openMainWindow(): void {
  mainWindow = createMainWindow({
    stateFile: path.join(paths.userData, 'window-state.json'),
    theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    preloadPath: path.join(__dirname, '../preload/index.js'),
    rendererDir: path.join(__dirname, '../renderer'),
    devServerUrl: app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
  });
  const win = mainWindow.window;
  win.on('focus', () => sessionManager?.setWindowFocused(true));
  win.on('blur', () => sessionManager?.setWindowFocused(false));
  win.on('closed', () => {
    mainWindow = null;
    browserPanel = null;
  });
}

async function shutdown(): Promise<void> {
  try {
    browserPanel?.close();
    await ptyManager?.disposeAll();
    await sessionManager?.disposeAll();
    if (servicesPromise) {
      const s = await servicesPromise;
      await s.shells.disposeAll();
      s.db.close();
    }
  } catch (error) {
    log.error('app', 'Error during shutdown', { message: (error as Error).message });
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindow?.window;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  if (process.platform === 'win32') app.setAppUserModelId('app.graft.desktop');

  registerHandlers({
    'app:info': () => ({
      name: 'Graft',
      version: app.getVersion(),
      platform: platform(),
      isPackaged: app.isPackaged,
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node }
    }),
    'window:setTitlebarTheme': ({ theme }) => {
      mainWindow?.setTheme(theme);
    },
    ...buildHandlers({
      services,
      sessions,
      ptys,
      browser,
      window: () => mainWindow?.window ?? null,
      emit,
      isFirstLaunch,
      version: app.getVersion()
    })
  });

  void app.whenReady().then(() => {
    installSecurityPolicy({ allowMicrophone: () => false });
    installRouter((contents, frameUrl) => {
      const handle = mainWindow;
      return handle !== null && contents.id === handle.window.webContents.id && handle.isAppUrl(frameUrl);
    });
    const missing = missingHandlers();
    if (missing.length > 0) log.warn('ipc', 'Channels without handlers', { channels: missing.join(',') });
    openMainWindow();
    log.info('app', 'Ready', { version: app.getVersion(), packaged: app.isPackaged, firstLaunch: isFirstLaunch });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
    });
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void shutdown().finally(() => app.exit(0));
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
