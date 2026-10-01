import { Menu, nativeImage, Tray } from 'electron';

export interface TrayDeps {
  iconPath: string;
  show(): void;
  quit(): void;
  /** Sessions with a turn in progress, for the tooltip. */
  runningCount(): number;
}

/**
 * Notification-area icon while "Keep running in the tray" is on: closing the
 * window then hides it and sessions keep working in the background.
 */
export class TrayController {
  private tray: Tray | null = null;
  private lastRunning = -1;

  constructor(private readonly deps: TrayDeps) {}

  get active(): boolean {
    return this.tray !== null;
  }

  sync(enabled: boolean): void {
    if (enabled && !this.tray) {
      const image = nativeImage.createFromPath(this.deps.iconPath);
      this.tray = new Tray(image);
      this.tray.on('click', () => this.deps.show());
      this.lastRunning = -1;
      this.refresh();
    } else if (!enabled && this.tray) {
      this.destroy();
    }
  }

  /** Updates the tooltip and menu (called when session states change). */
  refresh(): void {
    if (!this.tray) return;
    const running = this.deps.runningCount();
    if (running === this.lastRunning) return;
    this.lastRunning = running;
    this.tray.setToolTip(running > 0 ? `Graft · ${running} ${running === 1 ? 'session' : 'sessions'} working` : 'Graft');
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Graft', click: () => this.deps.show() },
        ...(running > 0 ? [{ label: `${running} ${running === 1 ? 'session' : 'sessions'} working`, enabled: false }] : []),
        { type: 'separator' },
        { label: 'Quit Graft', click: () => this.deps.quit() }
      ])
    );
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
