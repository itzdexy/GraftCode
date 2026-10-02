import { BrowserWindow, desktopCapturer, globalShortcut, screen } from 'electron';
import { fitWithin, toScreen, type ShotGeometry } from './keys';
import type { InputCommand, WindowsInput } from './windowsInput';

/** What the Computer tool needs; the model's coordinates are in its latest screenshot. */
export interface ComputerControl {
  screenshot(sessionId: string): Promise<{ mediaType: 'image/jpeg'; data: string; width: number; height: number }>;
  act(sessionId: string, action: ComputerAction): Promise<void>;
}

export type ComputerAction =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'click'; x: number; y: number; button: 'left' | 'right' | 'middle'; count: number }
  | { kind: 'drag'; x: number; y: number; toX: number; toY: number }
  | { kind: 'scroll'; x: number; y: number; amount: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; vks: number[] };

/** Screenshots are scaled to fit this box, which keeps them legible and their token cost bounded. */
const SHOT_MAX = { width: 1280, height: 800 };
/** The banner and the stop shortcut go away this long after the last action. */
const IDLE_MS = 8000;
export const STOP_SHORTCUT = 'Control+Alt+Escape';

const BANNER = `data:text/html;charset=utf-8,${encodeURIComponent(
  '<!doctype html><meta charset="utf-8"><body style="margin:0;font:600 13px system-ui,sans-serif;color:#f0efec;background:transparent;display:flex;justify-content:center"><div style="margin:4px;padding:7px 14px;border-radius:999px;background:rgba(23,24,22,.92);border:1px solid #3c4a36;box-shadow:0 4px 18px rgba(0,0,0,.35);white-space:nowrap"><span style="color:#7fbf6a">●</span>&nbsp; Graft is using this computer &nbsp;·&nbsp; Ctrl+Alt+Esc to stop</div></body>'
)}`;

/**
 * Computer use on the primary display: screenshots through Electron's screen
 * capture, input through the Windows helper. While it acts, an always-on-top
 * banner (kept out of screenshots) says so, and Ctrl+Alt+Esc stops the
 * sessions using it.
 */
export class DesktopComputer implements ComputerControl {
  private geometry: ShotGeometry | null = null;
  private banner: BrowserWindow | null = null;
  private idle: NodeJS.Timeout | null = null;
  private readonly sessions = new Set<string>();

  constructor(
    private readonly deps: {
      input: Pick<WindowsInput, 'run' | 'dispose'>;
      /** Ctrl+Alt+Esc: stop these sessions' turns. */
      stop(sessionIds: string[]): void;
      log(message: string): void;
    }
  ) {}

  async screenshot(sessionId: string): Promise<{ mediaType: 'image/jpeg'; data: string; width: number; height: number }> {
    this.inControl(sessionId);
    const display = screen.getPrimaryDisplay();
    const physical = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: physical });
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error('The screen could not be captured.');
    const size = fitWithin(physical.width, physical.height, SHOT_MAX.width, SHOT_MAX.height);
    const image = source.thumbnail.resize({ ...size, quality: 'good' });
    this.geometry = { width: size.width, height: size.height, display: { x: 0, y: 0, ...physical } };
    return { mediaType: 'image/jpeg', data: image.toJPEG(72).toString('base64'), ...size };
  }

  async act(sessionId: string, action: ComputerAction): Promise<void> {
    this.inControl(sessionId);
    const geometry = this.geometry ?? this.currentGeometry();
    const at = (x: number, y: number): { x: number; y: number } => toScreen(x, y, geometry);
    let command: InputCommand;
    switch (action.kind) {
      case 'move':
        command = { op: 'move', ...at(action.x, action.y) };
        break;
      case 'click':
        command = { op: 'click', ...at(action.x, action.y), button: action.button, count: action.count };
        break;
      case 'drag': {
        const to = at(action.toX, action.toY);
        command = { op: 'drag', ...at(action.x, action.y), toX: to.x, toY: to.y };
        break;
      }
      case 'scroll':
        command = { op: 'scroll', ...at(action.x, action.y), amount: action.amount };
        break;
      case 'type':
        command = { op: 'type', text: action.text };
        break;
      case 'key':
        command = { op: 'key', vks: action.vks };
        break;
    }
    await this.deps.input.run(command);
  }

  /** Without a screenshot yet, coordinates are read against the size a screenshot would have. */
  private currentGeometry(): ShotGeometry {
    const display = screen.getPrimaryDisplay();
    const physical = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
    return { ...fitWithin(physical.width, physical.height, SHOT_MAX.width, SHOT_MAX.height), display: { x: 0, y: 0, ...physical } };
  }

  /** Shows the banner and arms the stop shortcut until the agent has been idle for a while. */
  private inControl(sessionId: string): void {
    this.sessions.add(sessionId);
    if (!globalShortcut.isRegistered(STOP_SHORTCUT)) {
      const ok = globalShortcut.register(STOP_SHORTCUT, () => {
        const ids = [...this.sessions];
        this.release();
        this.deps.stop(ids);
      });
      if (!ok) this.deps.log('Could not register Ctrl+Alt+Esc to stop computer use.');
    }
    this.showBanner();
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.release(), IDLE_MS);
  }

  private showBanner(): void {
    if (!this.banner || this.banner.isDestroyed()) {
      const area = screen.getPrimaryDisplay().workArea;
      const width = 420;
      this.banner = new BrowserWindow({
        x: Math.round(area.x + (area.width - width) / 2),
        y: area.y + 8,
        width,
        height: 44,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false }
      });
      this.banner.setAlwaysOnTop(true, 'screen-saver');
      this.banner.setIgnoreMouseEvents(true);
      // Keeps the banner out of the agent's screenshots.
      this.banner.setContentProtection(true);
      void this.banner.loadURL(BANNER);
    }
    if (!this.banner.isVisible()) this.banner.showInactive();
  }

  /** Hides the banner and frees the shortcut. */
  release(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.sessions.clear();
    if (globalShortcut.isRegistered(STOP_SHORTCUT)) globalShortcut.unregister(STOP_SHORTCUT);
    if (this.banner && !this.banner.isDestroyed()) this.banner.hide();
  }

  dispose(): void {
    this.release();
    if (this.banner && !this.banner.isDestroyed()) this.banner.destroy();
    this.banner = null;
    this.deps.input.dispose();
  }
}
