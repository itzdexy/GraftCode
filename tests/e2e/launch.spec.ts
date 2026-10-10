import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { launchGraft } from './support/launch';

test('app launches with a sandboxed renderer and shows the Graft mark', async () => {
  const graft = await launchGraft();
  try {
    await expect(graft.window).toHaveTitle('Graft');
    await expect(graft.window.getByRole('img', { name: 'Graft' }).first()).toBeVisible();

    const posture = await graft.app.evaluate(({ app, BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('no window');
      const pid = win.webContents.getOSProcessId();
      const metric = app.getAppMetrics().find((m) => m.pid === pid);
      return { rendererSandboxed: metric?.sandboxed ?? null, minSize: win.getMinimumSize() };
    });
    // Electron reports the OS-level sandbox on Windows and macOS only.
    expect(posture).toEqual({ rendererSandboxed: process.platform === 'linux' ? null : true, minSize: [900, 600] });

    const surface = await graft.window.evaluate(() => ({
      hasRequire: 'require' in globalThis,
      hasProcess: 'process' in globalThis,
      bridgeKeys: Object.keys((window as unknown as { graft: object }).graft).sort()
    }));
    expect(surface).toEqual({ hasRequire: false, hasProcess: false, bridgeKeys: ['invoke', 'on', 'platform'] });

    const unknown = await graft.window.evaluate(() =>
      (window as unknown as { graft: { invoke(c: string, i?: unknown): Promise<unknown> } }).graft.invoke('fs:readAnything', {
        path: 'C:/Windows/win.ini'
      })
    );
    expect(unknown).toMatchObject({ ok: false, error: { code: 'unknown_channel' } });
  } finally {
    await graft.close();
  }
});

test('a page Graft did not write is granted nothing: not in the session that pictures sites, not in one nobody set up', async () => {
  // A page on this computer, as a site is: a secure context, where notifications and location can be asked for at all.
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>probe</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
  const graft = await launchGraft();
  try {
    const states = await graft.app.evaluate(async ({ BrowserWindow }, page) => {
      const probe = async (partition: string): Promise<{ notifications: string; location: string }> => {
        const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition } });
        try {
          await win.loadURL(page);
          return (await win.webContents.executeJavaScript(
            "navigator.permissions.query({ name: 'geolocation' }).then((status) => ({ notifications: Notification.permission, location: status.state }))"
          )) as { notifications: string; location: string };
        } finally {
          win.destroy();
        }
      };
      return { thumbnails: await probe('graft-site-thumbnails'), unknown: await probe('graft-e2e-never-set-up') };
    }, url);
    // Electron grants everything to a session with no handler; every session Graft makes starts out refusing.
    expect(states).toEqual({
      thumbnails: { notifications: 'denied', location: 'denied' },
      unknown: { notifications: 'denied', location: 'denied' }
    });
  } finally {
    await graft.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
