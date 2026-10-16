import path from 'node:path';
import { BrowserWindow, session, type Session } from 'electron';
import { GraftError } from '@shared/errors';
import { ARTIFACT_SCHEME, type ArtifactServer } from '../artifacts/artifacts';

/**
 * A picture of a diagram: the page's <svg role="img"> alone, without the page
 * around it, drawn by a hidden window.
 *
 * The page is something a model wrote, so it is drawn with scripts off, in a
 * session of its own that serves the preview scheme and nothing else: every
 * other request is cancelled, every permission refused, nothing opens and
 * nothing navigates. A diagram means the same with scripts off: its motion,
 * when it has any, is an extra on top of a complete still frame.
 */

/** No side of a picture is larger than this. */
const MAX_PIXELS = 8000;
const TIME_LIMIT_MS = 20_000;
/** How long the page gets for its fonts before the picture; they are data: addresses, so there is nothing to fetch. */
const SETTLE_MS = 400;
/** The room a diagram's page keeps on its two sides (2rem each): a window this much wider than the diagram draws it at its own size. */
const PAGE_MARGIN = 64;
const VIEW_HEIGHT = 1200;

/** The part of the page to draw and how much to enlarge it: twice, less when a side would pass 8,000 px. */
export function clipFor(box: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number; scale: number } {
  return { ...box, scale: Math.min(2, MAX_PIXELS / Math.max(box.width, box.height)) };
}

/** The name a copy is offered under: the page's, with the copy's ending. */
export function exportName(file: string, format: 'png' | 'svg'): string {
  const name = file.split(/[\\/]/).pop() ?? file;
  return `${name.replace(/\.html?$/i, '')}.${format}`;
}

export interface DiagramRenderer {
  /** A PNG of the diagram in `file`, which is `width` wide in its own units. One picture is drawn at a time. */
  png(file: string, width: number): Promise<Buffer>;
}

export function createDiagramRenderer(artifacts: ArtifactServer): DiagramRenderer {
  let isolated: Session | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const isolatedSession = (): Session => {
    if (isolated) return isolated;
    const ses = session.fromPartition('graft-diagrams', { cache: false });
    ses.protocol.handle(ARTIFACT_SCHEME, (request) => artifacts.respond(request.url));
    ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${ARTIFACT_SCHEME}:`) && !details.url.startsWith('data:') }));
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    isolated = ses;
    return ses;
  };

  const draw = async (file: string, width: number): Promise<Buffer> => {
    const name = path.basename(file);
    const viewWidth = Math.min(MAX_PIXELS, Math.round(width) + PAGE_MARGIN);
    const win = new BrowserWindow({
      show: false,
      useContentSize: true,
      width: viewWidth,
      height: VIEW_HEIGHT,
      webPreferences: { session: isolatedSession(), offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, webSecurity: true, spellcheck: false, disableDialogs: true }
    });
    const contents = win.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
    const ask = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => contents.debugger.sendCommand(method, params) as Promise<T>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new GraftError('render_timeout', `Drawing ${name} took longer than 20 seconds.`)), TIME_LIMIT_MS);
    });
    const picture = (async (): Promise<Buffer> => {
      await contents.loadURL(artifacts.urlForFile(file));
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      contents.debugger.attach('1.3');
      // One device pixel a CSS pixel, whatever the screen is set to, so the picture is exactly `scale` times the diagram.
      await ask('Emulation.setDeviceMetricsOverride', { width: viewWidth, height: VIEW_HEIGHT, deviceScaleFactor: 1, mobile: false });
      const { root } = await ask<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 });
      const { nodeId } = await ask<{ nodeId: number }>('DOM.querySelector', { nodeId: root.nodeId, selector: 'svg[role="img"]' });
      if (!nodeId) throw new GraftError('not_a_diagram', `Couldn't find the diagram in ${name}.`);
      // The content box as four corners, clockwise from the top left: x1, y1, x2, y2, x3, y3, x4, y4.
      const { model } = await ask<{ model: { content: number[] } }>('DOM.getBoxModel', { nodeId });
      const [x = 0, y = 0, right = 0, , , bottom = 0] = model.content;
      if (right - x < 1 || bottom - y < 1) throw new GraftError('not_a_diagram', `Couldn't find the diagram in ${name}.`);
      const shot = await ask<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: clipFor({ x, y, width: right - x, height: bottom - y }) });
      return Buffer.from(shot.data, 'base64');
    })();
    // The picture may still fail after the time limit has: that failure is nobody's to handle by then.
    picture.catch(() => undefined);
    try {
      return await Promise.race([picture, late]);
    } finally {
      clearTimeout(timer);
      if (!win.isDestroyed()) {
        if (contents.debugger.isAttached()) contents.debugger.detach();
        win.destroy();
      }
    }
  };

  return {
    png(file, width) {
      const next = queue.then(() => draw(file, width));
      queue = next.catch(() => undefined);
      return next;
    }
  };
}
