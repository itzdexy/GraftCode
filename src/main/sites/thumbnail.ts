import { BrowserWindow } from 'electron';

/** How long a page gets to load its fonts and settle its entrance animations before the picture. */
const SETTLE_MS = 1200;

/**
 * A picture of a page for the Sites gallery, taken in a hidden, offscreen,
 * sandboxed window with its own in-memory session (no preload, no popups).
 */
export async function capturePage(url: string): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'graft-site-thumbnails' }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== new URL(url).origin) event.preventDefault();
  });
  try {
    await win.loadURL(url);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const image = await win.webContents.capturePage();
    if (image.isEmpty()) throw new Error('The page drew nothing.');
    return image.resize({ width: 640, quality: 'good' }).toPNG();
  } finally {
    win.destroy();
  }
}
