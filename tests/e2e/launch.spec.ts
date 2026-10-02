import { expect, test } from '@playwright/test';
import { launchGraft, NO_SANDBOX } from './support/launch';

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
    expect(posture).toEqual({ rendererSandboxed: !NO_SANDBOX, minSize: [900, 600] });

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
