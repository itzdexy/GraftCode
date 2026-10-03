import { BrowserWindow, desktopCapturer, globalShortcut, screen } from 'electron';
import { fitWithin, toScreen, type ShotGeometry } from './keys';
import type { InputCommand, WindowsInput } from './windowsInput';

export interface Screenshot {
  mediaType: 'image/jpeg';
  data: string;
  width: number;
  height: number;
}

/** What the Computer tool needs; the model's coordinates are in its latest screenshot. */
export interface ComputerControl {
  screenshot(sessionId: string): Promise<Screenshot>;
  /** A closer look at part of the latest screenshot, at the screen's full resolution. Coordinates stay those of the full screenshot. */
  zoom(sessionId: string, region: { x: number; y: number; toX: number; toY: number }): Promise<Screenshot>;
  act(sessionId: string, action: ComputerAction): Promise<void>;
}

export type ComputerAction =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'click'; x: number; y: number; button: 'left' | 'right' | 'middle'; count: number }
  | { kind: 'drag'; x: number; y: number; toX: number; toY: number }
  | { kind: 'scroll'; x: number; y: number; amount: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; vks: number[] }
  /** Opens an app by name from the Start menu, the way a person would. */
  | { kind: 'open'; name: string };

/** Screenshots are scaled to fit this box, which keeps them legible and their token cost bounded. */
const SHOT_MAX = { width: 1280, height: 800 };
/** The banner and the stop shortcut go away this long after the last action. */
const IDLE_MS = 8000;
const CLICK_RING_MS = 750;
const VK_WIN = 0x5b;
const VK_ENTER = 0x0d;
export const STOP_SHORTCUT = 'Control+Alt+Escape';

/** What the banner says the agent is doing. */
const DOING: Record<ComputerAction['kind'] | 'look', string> = {
  look: 'Looking at the screen',
  move: 'Moving the pointer',
  click: 'Clicking',
  drag: 'Dragging',
  scroll: 'Scrolling',
  type: 'Typing',
  key: 'Pressing keys',
  open: 'Opening an app'
};

function bannerPage(doing: string): string {
  const safe = doing.replace(/[<>&"]/g, '');
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><meta charset="utf-8"><style>@keyframes b{50%{opacity:.35}}</style><body style="margin:0;font:600 13px system-ui,sans-serif;color:#f0efec;background:transparent;display:flex;justify-content:center"><div style="margin:4px;padding:7px 14px;border-radius:999px;background:rgba(23,24,22,.92);border:1px solid #3c4a36;box-shadow:0 4px 18px rgba(0,0,0,.35);white-space:nowrap"><span style="color:#7fbf6a;animation:b 1.2s ease-in-out infinite">●</span>&nbsp; Graft: ${safe} &nbsp;·&nbsp; Ctrl+Alt+Esc to stop</div></body>`
  )}`;
}

/** A ring that grows and fades where the agent clicked, drawn with CSS alone (the window runs no script). */
export function clickRingPage(x: number, y: number): string {
  const at = `left:${Math.round(x)}px;top:${Math.round(y)}px`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}.r,.d{position:absolute;${at};border-radius:50%}.r{width:34px;height:34px;margin:-17px 0 0 -17px;border:2px solid #7fbf6a;box-shadow:0 0 0 2px rgba(0,0,0,.3);animation:g ${CLICK_RING_MS}ms ease-out forwards}.d{width:9px;height:9px;margin:-4.5px 0 0 -4.5px;background:#7fbf6a;box-shadow:0 0 0 2px rgba(0,0,0,.3);animation:f ${CLICK_RING_MS}ms ease-out forwards}@keyframes g{from{transform:scale(.35);opacity:1}to{transform:scale(1.9);opacity:0}}@keyframes f{70%{opacity:1}to{opacity:0}}</style><div class="r"></div><div class="d"></div>`
  )}`;
}

function overlayWindow(bounds: Electron.Rectangle): BrowserWindow {
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  // Kept out of the agent's screenshots: it should see the screen, not Graft's markers.
  win.setContentProtection(true);
  return win;
}

/**
 * Computer use on the primary display: screenshots through Electron's screen
 * capture, input through the Windows helper. While it acts, an always-on-top
 * banner says what it is doing, a ring marks each click (both kept out of
 * screenshots), and Ctrl+Alt+Esc stops the sessions using it.
 */
export class DesktopComputer implements ComputerControl {
  private geometry: ShotGeometry | null = null;
  private banner: BrowserWindow | null = null;
  private ring: BrowserWindow | null = null;
  private ringTimer: NodeJS.Timeout | null = null;
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

  /** The primary display, captured at its full physical resolution. */
  private async capture(): Promise<{ image: Electron.NativeImage; physical: { width: number; height: number } }> {
    const display = screen.getPrimaryDisplay();
    const physical = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: physical });
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error('The screen could not be captured.');
    return { image: source.thumbnail, physical };
  }

  async screenshot(sessionId: string): Promise<Screenshot> {
    this.inControl(sessionId, 'look');
    const { image, physical } = await this.capture();
    const size = fitWithin(physical.width, physical.height, SHOT_MAX.width, SHOT_MAX.height);
    const scaled = image.resize({ ...size, quality: 'good' });
    this.geometry = { width: size.width, height: size.height, display: { x: 0, y: 0, ...physical } };
    return { mediaType: 'image/jpeg', data: scaled.toJPEG(72).toString('base64'), ...size };
  }

  async zoom(sessionId: string, region: { x: number; y: number; toX: number; toY: number }): Promise<Screenshot> {
    this.inControl(sessionId, 'look');
    const geometry = this.geometry ?? this.currentGeometry();
    const a = toScreen(Math.min(region.x, region.toX), Math.min(region.y, region.toY), geometry);
    const b = toScreen(Math.max(region.x, region.toX), Math.max(region.y, region.toY), geometry);
    const crop = { x: a.x, y: a.y, width: Math.max(8, b.x - a.x), height: Math.max(8, b.y - a.y) };
    const { image } = await this.capture();
    const part = image.crop(crop);
    // Up to the usual box, but never larger than the pixels actually there.
    const size = fitWithin(part.getSize().width, part.getSize().height, SHOT_MAX.width, SHOT_MAX.height);
    return { mediaType: 'image/jpeg', data: part.resize({ ...size, quality: 'best' }).toJPEG(85).toString('base64'), ...size };
  }

  async act(sessionId: string, action: ComputerAction): Promise<void> {
    this.inControl(sessionId, action.kind);
    const geometry = this.geometry ?? this.currentGeometry();
    const at = (x: number, y: number): { x: number; y: number } => toScreen(x, y, geometry);
    if (action.kind === 'open') {
      // Start menu search: press Windows, type the name, let results settle, press Enter.
      await this.deps.input.run({ op: 'key', vks: [VK_WIN] });
      await new Promise((r) => setTimeout(r, 500));
      await this.deps.input.run({ op: 'type', text: action.name });
      await new Promise((r) => setTimeout(r, 900));
      await this.deps.input.run({ op: 'key', vks: [VK_ENTER] });
      return;
    }
    let command: InputCommand;
    switch (action.kind) {
      case 'move':
        command = { op: 'move', ...at(action.x, action.y) };
        break;
      case 'click': {
        const point = at(action.x, action.y);
        this.showClick(point);
        command = { op: 'click', ...point, button: action.button, count: action.count };
        break;
      }
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

  /** A ring at a physical screen point, so whoever watches sees where the agent clicked. */
  private showClick(physical: { x: number; y: number }): void {
    try {
      const display = screen.getPrimaryDisplay();
      if (!this.ring || this.ring.isDestroyed()) this.ring = overlayWindow(display.bounds);
      else this.ring.setBounds(display.bounds);
      void this.ring.loadURL(clickRingPage(physical.x / display.scaleFactor, physical.y / display.scaleFactor));
      this.ring.showInactive();
      if (this.ringTimer) clearTimeout(this.ringTimer);
      this.ringTimer = setTimeout(() => {
        if (this.ring && !this.ring.isDestroyed()) this.ring.hide();
      }, CLICK_RING_MS + 100);
    } catch (error) {
      // Only a visual aid: the click itself still happens.
      this.deps.log(`Could not show the click marker: ${(error as Error).message}`);
    }
  }

  /** Shows the banner and arms the stop shortcut until the agent has been idle for a while. */
  private inControl(sessionId: string, doing: keyof typeof DOING): void {
    this.sessions.add(sessionId);
    if (!globalShortcut.isRegistered(STOP_SHORTCUT)) {
      const ok = globalShortcut.register(STOP_SHORTCUT, () => {
        const ids = [...this.sessions];
        this.release();
        this.deps.stop(ids);
      });
      if (!ok) this.deps.log('Could not register Ctrl+Alt+Esc to stop computer use.');
    }
    this.showBanner(DOING[doing]);
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.release(), IDLE_MS);
  }

  private showBanner(doing: string): void {
    if (!this.banner || this.banner.isDestroyed()) {
      const area = screen.getPrimaryDisplay().workArea;
      const width = 460;
      this.banner = overlayWindow({ x: Math.round(area.x + (area.width - width) / 2), y: area.y + 8, width, height: 44 });
    }
    void this.banner.loadURL(bannerPage(doing));
    if (!this.banner.isVisible()) this.banner.showInactive();
  }

  /** Hides the banner and frees the shortcut. */
  release(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.sessions.clear();
    if (globalShortcut.isRegistered(STOP_SHORTCUT)) globalShortcut.unregister(STOP_SHORTCUT);
    if (this.banner && !this.banner.isDestroyed()) this.banner.hide();
    if (this.ring && !this.ring.isDestroyed()) this.ring.hide();
  }

  dispose(): void {
    this.release();
    if (this.ringTimer) clearTimeout(this.ringTimer);
    for (const win of [this.banner, this.ring]) if (win && !win.isDestroyed()) win.destroy();
    this.banner = null;
    this.ring = null;
    this.deps.input.dispose();
  }
}
