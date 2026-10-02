import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, nativeTheme, powerSaveBlocker, protocol, safeStorage } from 'electron';
import type { AppInfo } from '@shared/ipc/contracts';
import type { AppSettings } from '@shared/schemas/appSettings';
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
import { McpManager } from './mcp/mcpManager';
import { ARTIFACT_SCHEME, ArtifactServer } from './artifacts/artifacts';
import { Scheduler } from './schedule/scheduler';
import { openExternalSafely } from './app/security';
import { KeepAwake } from './app/keepAwake';
import { DesktopComputer } from './computer/desktop';
import { WindowsInput } from './computer/windowsInput';
import { TrayController } from './app/tray';
import { UpdateController } from './app/updater';

// Test and E2E runs isolate all state before anything touches userData.
if (process.env.GRAFT_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.GRAFT_USER_DATA_DIR));
}

// Artifact previews are served from their own privileged, sandboxed scheme.
protocol.registerSchemesAsPrivileged([{ scheme: ARTIFACT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

const paths = buildPaths(app.getPath('userData'));
configureLogFile(paths.logs);
const isFirstLaunch = !fs.existsSync(paths.database);

let mainWindow: MainWindowHandle | null = null;
let servicesPromise: Promise<Services> | null = null;
let sessionManager: SessionManager | null = null;
let ptyManager: PtyManager | null = null;
let mcpManager: McpManager | null = null;
let scheduler: Scheduler | null = null;
const artifactServer = new ArtifactServer();
let browserPanel: BrowserPanel | null = null;
let quitting = false;
let settingsSnapshot: AppSettings | null = null;

/** Bundled resources (icons, catalog): next to the app when installed, in the repo during development. */
function resourcePath(...parts: string[]): string {
  return app.isPackaged ? path.join(process.resourcesPath, ...parts) : path.join(__dirname, '../../resources', ...parts);
}

function iconPath(name: string): string {
  return resourcePath('icons', name);
}

function showWindow(): void {
  const win = mainWindow?.window;
  if (!win) {
    if (app.isReady()) openMainWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

const tray = new TrayController({
  iconPath: iconPath('tray.png'),
  show: showWindow,
  quit: () => app.quit(),
  runningCount: () => sessionManager?.runningCount() ?? 0
});

const keepAwake = new KeepAwake({
  start: () => powerSaveBlocker.start('prevent-app-suspension'),
  stop: (id) => powerSaveBlocker.stop(id)
});

/** Computer use runs on Windows; created on first use, stopped from Ctrl+Alt+Esc. */
let desktop: DesktopComputer | null = null;
function computer(): DesktopComputer | null {
  if (process.platform !== 'win32') return null;
  desktop ??= new DesktopComputer({
    input: new WindowsInput(),
    stop: (ids) => {
      for (const id of ids) sessionManager?.interrupt(id);
    },
    log: (message) => log.warn('computer', message)
  });
  return desktop;
}

const updates = new UpdateController({
  enabled: () => settingsSnapshot?.updates.enabled ?? false,
  support: () => {
    if (!app.isPackaged) return { ok: false, reason: 'Updates are delivered to installed builds.' };
    if (!fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return { ok: false, reason: 'This build has no update feed configured.' };
    return { ok: true };
  },
  loadBackend: async () => (await import('electron-updater')).autoUpdater,
  emit: (state) => emit({ type: 'updates:state', state }),
  log: (level, message, fields) => log[level]('updates', message, fields)
});

/** Tray and update checks follow their settings. */
function applySystemSettings(settings: AppSettings): void {
  settingsSnapshot = settings;
  tray.sync(settings.behavior.runInTray);
  updates.sync();
}

/** app.getVersion() reports Electron's own version when run unpackaged from out/main, so read package.json then. */
function readAppVersion(): string {
  if (app.isPackaged) return app.getVersion();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : app.getVersion();
  } catch (error) {
    log.warn('app', 'Could not read the version from package.json', { message: (error as Error).message });
    return app.getVersion();
  }
}
const appVersion = readAppVersion();

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
    onProgress: (step, label, done, total) => emit({ type: 'init:progress', step, label, done, total }),
    catalogFile: resourcePath('catalog', 'models.json')
  })
    .then((s) => {
      applySystemSettings(s.settings.get());
      s.shells.on('change', (sessionId: string) => emit({ type: 'shells:changed', sessionId }));
      s.shells.on('error-log', (message: string) => log.warn('shell', message));
      // Scheduled sessions run while the app is open.
      queueMicrotask(() => {
        schedules()
          .then((sch) => sch.start())
          .catch((error: unknown) => log.error('schedule', 'Could not start the scheduler', { message: (error as Error).message }));
      });
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

async function schedules(): Promise<Scheduler> {
  if (scheduler) return scheduler;
  const s = await services();
  scheduler ??= new Scheduler({
    db: s.db,
    start: async (schedule) => {
      const manager = await sessions();
      const model = schedule.providerId && schedule.modelId ? { providerId: schedule.providerId, modelId: schedule.modelId } : null;
      const summary = await manager.create({
        kind: 'code',
        projectPath: schedule.projectPath,
        useWorktree: false,
        branch: null,
        model,
        effort: schedule.effort,
        permissionMode: schedule.permissionMode,
        incognito: false,
        message: { text: schedule.prompt, images: [], files: [] }
      });
      manager.rename(summary.id, `${schedule.name} · ${new Date().toLocaleString()}`);
      return summary.id;
    },
    sessionStatus: (id) => {
      try {
        return sessionManager?.summary(id).status ?? null;
      } catch (error) {
        log.info('schedule', 'Run session is gone', { message: (error as Error).message });
        return null;
      }
    },
    onChange: () => emit({ type: 'schedules:changed' }),
    log: (level, message, fields) => log[level]('schedule', message, fields)
  });
  return scheduler;
}

function browser(): BrowserPanel {
  const win = mainWindow?.window;
  if (!win) throw new Error('The window is closed.');
  browserPanel ??= new BrowserPanel(win, (state) => emit({ type: 'browser:state', state }));
  return browserPanel;
}

async function mcp(): Promise<McpManager> {
  if (mcpManager) return mcpManager;
  const s = await services();
  if (!mcpManager) {
    mcpManager = new McpManager({
      settings: s.settingsFiles,
      registry: s.tools,
      keys: s.keys,
      openBrowser: (url) => openExternalSafely(url),
      log: (level, message, fields) => log[level]('mcp', message, fields),
      onChange: () => emit({ type: 'mcp:changed' }),
      version: app.getVersion()
    });
    // User-scope servers connect right away; failures show in Customize.
    mcpManager.sync().catch((error: unknown) => log.warn('mcp', 'Could not start MCP servers', { message: (error as Error).message }));
  }
  return mcpManager;
}

async function sessions(): Promise<SessionManager> {
  if (sessionManager) return sessionManager;
  const s = await services();
  const m = await mcp();
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
    mcp: m,
    search: s.search,
    computer: computer(),
    emitEvent: (sessionId, event) => {
      emit({ type: 'session:event', sessionId, event });
      if (event.type === 'status') {
        keepAwake.status(sessionId, event.status);
        tray.refresh();
      }
    },
    emitSummary: (summary) => {
      emit({ type: 'session:summary', summary });
      tray.refresh();
    },
    emitRemoved: (sessionId) => {
      emit({ type: 'session:removed', sessionId });
      keepAwake.forget(sessionId);
    },
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
    devServerUrl: app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL,
    iconPath: iconPath('app.png')
  });
  const win = mainWindow.window;
  // With the tray on, closing hides the window; sessions keep running.
  win.on('close', (event) => {
    if (quitting || !tray.active) return;
    event.preventDefault();
    win.hide();
    sessionManager?.setWindowFocused(false);
  });
  win.on('focus', () => sessionManager?.setWindowFocused(true));
  win.on('blur', () => sessionManager?.setWindowFocused(false));
  win.on('closed', () => {
    mainWindow = null;
    browserPanel = null;
  });
}

async function shutdown(): Promise<void> {
  try {
    updates.dispose();
    desktop?.dispose();
    keepAwake.dispose();
    tray.destroy();
    scheduler?.stop();
    browserPanel?.close();
    await ptyManager?.disposeAll();
    await mcpManager?.disposeAll();
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
  app.on('second-instance', () => showWindow());

  if (process.platform === 'win32') app.setAppUserModelId('app.graft.desktop');

  registerHandlers({
    'app:info': () => ({
      name: 'Graft',
      version: appVersion,
      platform: platform(),
      isPackaged: app.isPackaged,
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
      dataDir: paths.userData
    }),
    'power:keepAwake': ({ sessionId, on }) => ({ on: keepAwake.set(sessionId, on) }),
    'power:keepAwakeList': () => keepAwake.list(),
    'window:setTitlebarTheme': ({ theme }) => {
      mainWindow?.setTheme(theme);
    },
    ...buildHandlers({
      services,
      sessions,
      ptys,
      mcp,
      scheduler: schedules,
      artifacts: artifactServer,
      browser,
      window: () => mainWindow?.window ?? null,
      emit,
      updates,
      settingsChanged: applySystemSettings,
      isFirstLaunch,
      version: appVersion
    })
  });

  void app.whenReady().then(() => {
    installSecurityPolicy({ allowMicrophone: () => false });
    installRouter((contents, frameUrl) => {
      const handle = mainWindow;
      return handle !== null && contents.id === handle.window.webContents.id && handle.isAppUrl(frameUrl);
    });
    protocol.handle(ARTIFACT_SCHEME, (request) => artifactServer.respond(request.url));
    const missing = missingHandlers();
    if (missing.length > 0) log.warn('ipc', 'Channels without handlers', { channels: missing.join(',') });
    openMainWindow();
    log.info('app', 'Ready', { version: appVersion, packaged: app.isPackaged, firstLaunch: isFirstLaunch });
    app.on('activate', () => {
      // A window hidden to the tray comes back; otherwise open a new one.
      if (mainWindow) showWindow();
      else if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
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
