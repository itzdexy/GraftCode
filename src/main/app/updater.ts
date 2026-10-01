import type { UpdateState } from '@shared/schemas/system';

/** The part of electron-updater's autoUpdater Graft uses (injected so tests don't load Electron). */
export interface UpdaterBackend {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (arg: unknown) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdaterDeps {
  /** Settings → About → "Check for updates automatically". */
  enabled(): boolean;
  /** Installed builds with an update feed only; the reason is shown otherwise. */
  support(): { ok: true } | { ok: false; reason: string };
  loadBackend(): Promise<UpdaterBackend>;
  emit(state: UpdateState): void;
  log(level: 'info' | 'warn', message: string, fields?: Record<string, string>): void;
  now?: () => number;
}

const FIRST_CHECK_MS = 20_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

function versionOf(info: unknown): string | null {
  const version = (info as { version?: unknown } | null)?.version;
  return typeof version === 'string' ? version.slice(0, 64) : null;
}

/**
 * Background updates from the feed configured at build time. Updates
 * download quietly and install on the next quit, or right away from the
 * "Restart to update" action.
 */
export class UpdateController {
  private state: UpdateState;
  private backend: UpdaterBackend | null = null;
  private firstCheck: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;

  constructor(private readonly deps: UpdaterDeps) {
    this.state = this.baseline();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private baseline(): UpdateState {
    const empty = { version: null, progress: null, message: null, checkedAt: null };
    if (!this.deps.enabled()) return { status: 'off', ...empty };
    const support = this.deps.support();
    if (!support.ok) return { status: 'unsupported', ...empty, message: support.reason };
    return { status: 'idle', ...empty };
  }

  get(): UpdateState {
    return this.state;
  }

  private set(next: UpdateState): void {
    this.state = next;
    this.deps.emit(next);
  }

  private async ensureBackend(): Promise<UpdaterBackend> {
    if (this.backend) return this.backend;
    const backend = await this.deps.loadBackend();
    if (this.backend) return this.backend;
    backend.autoDownload = true;
    backend.autoInstallOnAppQuit = true;
    backend.on('checking-for-update', () => this.set({ ...this.state, status: 'checking', message: null }));
    backend.on('update-available', (info) => this.set({ ...this.state, status: 'downloading', version: versionOf(info), progress: 0, message: null, checkedAt: this.now() }));
    backend.on('update-not-available', () => this.set({ ...this.state, status: 'none', version: null, progress: null, message: null, checkedAt: this.now() }));
    backend.on('download-progress', (progress) => {
      const percent = (progress as { percent?: unknown } | null)?.percent;
      if (typeof percent === 'number' && Number.isFinite(percent)) this.set({ ...this.state, status: 'downloading', progress: Math.max(0, Math.min(100, percent)) });
    });
    backend.on('update-downloaded', (info) => {
      this.deps.log('info', 'Update downloaded', { version: versionOf(info) ?? '' });
      this.set({ ...this.state, status: 'ready', version: versionOf(info) ?? this.state.version, progress: 100, message: null });
    });
    backend.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log('warn', 'Update check failed', { message });
      this.set({ ...this.state, status: 'error', progress: null, message: message.slice(0, 300), checkedAt: this.now() });
    });
    this.backend = backend;
    return backend;
  }

  /** Applies the current setting: starts or stops background checks. */
  sync(): void {
    const base = this.baseline();
    if (base.status === 'off' || base.status === 'unsupported') {
      this.stopTimers();
      // A downloaded update must not install behind the user's back once they turned updates off.
      if (this.backend) this.backend.autoInstallOnAppQuit = false;
      this.set(base);
      return;
    }
    if (this.backend) this.backend.autoInstallOnAppQuit = true;
    if (this.state.status === 'off' || this.state.status === 'unsupported') this.set(base);
    if (this.firstCheck || this.interval) return;
    this.firstCheck = setTimeout(() => {
      this.firstCheck = null;
      void this.check();
    }, FIRST_CHECK_MS);
    this.interval = setInterval(() => void this.check(), CHECK_EVERY_MS);
  }

  async check(): Promise<UpdateState> {
    const base = this.baseline();
    if (base.status === 'off' || base.status === 'unsupported') {
      this.set(base);
      return this.state;
    }
    if (this.state.status === 'checking' || this.state.status === 'downloading' || this.state.status === 'ready') return this.state;
    try {
      this.set({ ...this.state, status: 'checking', message: null });
      const backend = await this.ensureBackend();
      await backend.checkForUpdates();
    } catch (error) {
      const message = (error as Error).message;
      this.deps.log('warn', 'Update check failed', { message });
      this.set({ ...this.state, status: 'error', progress: null, message: message.slice(0, 300), checkedAt: this.now() });
    }
    return this.state;
  }

  /** Quits and runs the downloaded installer. */
  install(): void {
    if (this.state.status !== 'ready' || !this.backend) throw new Error('No update is ready to install.');
    this.backend.quitAndInstall(false, true);
  }

  private stopTimers(): void {
    if (this.firstCheck) clearTimeout(this.firstCheck);
    if (this.interval) clearInterval(this.interval);
    this.firstCheck = null;
    this.interval = null;
  }

  dispose(): void {
    this.stopTimers();
  }
}
