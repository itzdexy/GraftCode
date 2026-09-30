import path from 'node:path';
import { app, BrowserWindow, nativeTheme } from 'electron';
import type { AppInfo } from '@shared/ipc/contracts';
import { buildPaths } from './app/paths';
import { configureLogFile, log } from './app/log';
import { createMainWindow, type MainWindowHandle } from './app/mainWindow';
import { installSecurityPolicy } from './app/security';
import { installRouter, missingHandlers, registerHandlers } from './ipc/router';

// Test and E2E runs isolate all state before anything touches userData.
if (process.env.GRAFT_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.GRAFT_USER_DATA_DIR));
}

const paths = buildPaths(app.getPath('userData'));
configureLogFile(paths.logs);

let mainWindow: MainWindowHandle | null = null;

function platform(): AppInfo['platform'] {
  const p = process.platform;
  if (p === 'win32' || p === 'darwin' || p === 'linux') return p;
  throw new Error(`Unsupported platform: ${p}`);
}

function openMainWindow(): void {
  mainWindow = createMainWindow({
    stateFile: path.join(paths.userData, 'window-state.json'),
    theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    preloadPath: path.join(__dirname, '../preload/index.js'),
    rendererDir: path.join(__dirname, '../renderer'),
    devServerUrl: app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
  });
  mainWindow.window.on('closed', () => {
    mainWindow = null;
  });
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
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node
      }
    }),
    'window:setTitlebarTheme': ({ theme }) => {
      mainWindow?.setTheme(theme);
    }
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
    log.info('app', 'Ready', { version: app.getVersion(), packaged: app.isPackaged });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
